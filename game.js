'use strict';
/* Deadlock Feud — host-authoritative game relayed through a public MQTT broker (WebSockets).
   The host's browser is the "server". Players connect with a 4-letter room code.
   A WebSocket relay works on any network, unlike direct WebRTC peer connections. */

const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const TOPIC = code => 'dlfeud/v2/' + code;
const $ = s => document.querySelector(s);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const clean = (s, n = 20) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

let client = null, room = null, role = null;
const myId = Math.random().toString(36).slice(2, 10);
const seen = new Map();      // host only: playerId -> last time we heard from them
let H = null;                // host only: full private state
let pub = null, prev = null; // public state (what everybody sees)

/* ---------- sound ---------- */
let actx;
function tone(freq, dur, type = 'sine', vol = 0.15, delay = 0) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + delay;
    o.type = type; o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur);
  } catch (e) { /* audio not available */ }
}
const sfx = {
  ding() { tone(880, .25); tone(1320, .4, 'sine', .12, .12); },
  strike() { tone(110, .7, 'sawtooth', .2); },
  buzz() { tone(520, .18, 'square', .1); tone(390, .25, 'square', .1, .1); },
  win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, .3, 'triangle', .14, i * .12)); }
};

/* ---------- UI helpers ---------- */
function homeMsg(t) { $('#home-msg').textContent = t || ''; }
function toast(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => e.hidden = true, 2600); }
function enterGame() { $('#home').hidden = true; $('#game').hidden = false; }
const makeCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join(''); };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* =====================================================================
   HOST
   ===================================================================== */
// Connect to the first broker that answers. Host and players try them in the same order.
function connectBroker(will, i = 0) {
  return new Promise((resolve, reject) => {
    const c = mqtt.connect(BROKERS[i], { clientId: 'dlf_' + myId + '_' + i, will, reconnectPeriod: 2000, connectTimeout: 7000 });
    const t = setTimeout(() => {
      c.end(true);
      if (i + 1 < BROKERS.length) connectBroker(will, i + 1).then(resolve, reject); else reject();
    }, 7000);
    c.once('connect', () => { clearTimeout(t); resolve(c); });
  });
}

async function startHost() {
  homeMsg('Opening room…');
  const code = makeCode();
  room = TOPIC(code);
  try { client = await connectBroker({ topic: room + '/state', payload: '', retain: true, qos: 1 }); }
  catch (_) { room = null; return homeMsg('Could not reach the game server. Check your connection and try again.'); }
  role = 'host';
  client.subscribe(room + '/up', { qos: 1 });
  client.on('message', (t, m) => { if (t === room + '/up') { try { onHostData(JSON.parse(m)); } catch (_) {} } });
  client.on('connect', broadcast); // republish after a reconnect
  addEventListener('pagehide', () => client.publish(room + '/state', '', { retain: true }));
  setInterval(() => seen.forEach((t, id) => { if (Date.now() - t > 20000) dropPlayer(id); }), 5000);
  initHost(code); enterGame();
}

function initHost(code) {
  H = {
    code, order: shuffle(window.QUESTIONS.map((_, i) => i)), qNum: 0, q: null,
    answers: [], strikes: 0, bank: 0, scores: { A: 0, B: 0 },
    teamNames: { A: 'Amber', B: 'Sapphire' }, control: null,
    buzzOpen: false, buzz: null, phase: 'lobby', players: [], feed: []
  };
  broadcast();
}

const mult = () => !H || H.qNum <= 3 ? 1 : H.qNum <= 6 ? 2 : 3;

function publicState() {
  return {
    code: H.code, phase: H.phase, qNum: H.qNum, total: H.order.length, mult: mult(),
    question: H.q ? H.q.q : '',
    answers: H.answers.map(a => a.revealed ? { revealed: true, text: a.text, points: a.points } : { revealed: false }),
    strikes: H.strikes, bank: H.bank, scores: H.scores, teamNames: H.teamNames,
    control: H.control, buzzOpen: H.buzzOpen, buzz: H.buzz,
    players: H.players.map(p => ({ id: p.id, name: p.name, team: p.team })),
    feed: H.feed.slice(-6)
  };
}

function broadcast() {
  pub = publicState();
  if (client) client.publish(room + '/state', JSON.stringify({ t: 'state', s: pub }), { qos: 1, retain: true });
  render();
}

function onHostData(d) {
  if (!d || typeof d !== 'object' || !H) return;
  const id = clean(d.from, 16); if (!id) return;
  if (d.t === 'leave') return dropPlayer(id);
  seen.set(id, Date.now());
  let p = H.players.find(x => x.id === id);
  if (d.t === 'join') { // players re-send join every few seconds as a heartbeat
    const name = clean(d.name) || 'Player';
    if (!p) {
      const nA = H.players.filter(x => x.team === 'A').length, nB = H.players.length - nA;
      H.players.push({ id, name, team: nA <= nB ? 'A' : 'B' });
      broadcast();
    } else if (p.name !== name) { p.name = name; broadcast(); }
    return;
  }
  if (!p) return;
  if (d.t === 'buzz') {
    if (H.buzzOpen && !H.buzz) { H.buzz = { id: p.id, name: p.name, team: p.team }; H.buzzOpen = false; broadcast(); }
  } else if (d.t === 'answer') {
    const text = clean(d.text, 60);
    if (text) { H.feed.push({ name: p.name, team: p.team, text }); if (H.feed.length > 30) H.feed.shift(); broadcast(); }
  }
}

function dropPlayer(id) {
  if (!H) return;
  seen.delete(id);
  const i = H.players.findIndex(p => p.id === id);
  if (i >= 0) { H.players.splice(i, 1); broadcast(); }
}

const other = t => t === 'A' ? 'B' : 'A';

const actions = {
  start() { actions.next(); },
  next() {
    if (H.qNum >= H.order.length) { H.phase = 'gameover'; H.q = null; H.answers = []; H.buzzOpen = false; H.buzz = null; return; }
    H.q = window.QUESTIONS[H.order[H.qNum]]; H.qNum++;
    H.answers = H.q.a.slice(0, 8).map(([text, points]) => ({ text, points, revealed: false }));
    H.strikes = 0; H.bank = 0; H.control = null; H.buzz = null; H.buzzOpen = false; H.phase = 'faceoff';
  },
  openBuzz() { if (!H.q) return; H.buzz = null; H.buzzOpen = true; },
  closeBuzz() { H.buzzOpen = false; },
  control(team) { H.control = team; if (H.phase === 'faceoff') { H.phase = 'play'; H.strikes = 0; } },
  reveal(i) {
    const a = H.answers[i]; if (!a || a.revealed || !H.q) return;
    a.revealed = true; H.bank += a.points;
    if (H.answers.every(x => x.revealed) && H.phase === 'play') H.phase = 'roundover';
  },
  strike() {
    if (!H.q || H.phase === 'roundover' || H.phase === 'lobby') return;
    H.strikes = Math.min(3, H.strikes + 1);
    if (H.strikes >= 3 && H.phase === 'play') H.phase = 'steal';
  },
  award(team) {
    if (!H.q) return;
    H.scores[team] += H.bank * mult(); H.bank = 0;
    H.answers.forEach(a => a.revealed = true);
    H.phase = 'roundover'; H.buzzOpen = false;
  },
  swap(id) { const p = H.players.find(x => x.id === id); if (p) p.team = other(p.team); },
  rename() {
    for (const t of ['A', 'B']) { const n = clean(prompt('Name for team ' + t + ':', H.teamNames[t]), 14); if (n) H.teamNames[t] = n; }
  },
  resetScores() { if (confirm('Reset both scores to 0?')) H.scores = { A: 0, B: 0 }; },
  clearFeed() { H.feed = []; }
};

function act(name, arg) {
  if (role !== 'host' || !H) return;
  actions[name](arg);
  broadcast();
}

/* =====================================================================
   PLAYER
   ===================================================================== */
function sendUp(d) {
  if (client && room) client.publish(room + '/up', JSON.stringify(Object.assign({ from: myId }, d)), { qos: 1 });
}

async function joinGame(code, name) {
  homeMsg('Connecting…');
  room = TOPIC(code);
  try { client = await connectBroker({ topic: room + '/up', payload: JSON.stringify({ t: 'leave', from: myId }), qos: 0 }); }
  catch (_) { room = null; return homeMsg('Could not reach the game server. Check your connection and try again.'); }
  client.on('message', (t, m) => {
    if (t !== room + '/state') return;
    if (!m.length) { if (pub) toast('The host left, so the game has ended'); return; }
    let d; try { d = JSON.parse(m); } catch (_) { return; }
    if (d.t !== 'state') return;
    pub = d.s;
    if (role !== 'player') { role = 'player'; homeMsg(''); enterGame(); }
    render();
  });
  client.subscribe(room + '/state', { qos: 1 });
  sendUp({ t: 'join', name });
  setInterval(() => sendUp({ t: 'join', name }), 5000);
  addEventListener('pagehide', () => sendUp({ t: 'leave' }));
  setTimeout(() => { if (!pub) homeMsg('Room not found. Check the code with your host.'); }, 6000);
}

/* =====================================================================
   RENDER (shared by host and players)
   ===================================================================== */
const PHASE = { lobby: 'Lobby', faceoff: 'Face-off', play: 'Playing', steal: 'Steal!', roundover: 'Round over', gameover: 'Game over' };

function render() {
  if (!pub) return;
  const s = pub, isHost = role === 'host';
  $('#room-code').textContent = s.code;
  $('#phase-label').textContent = PHASE[s.phase] || '';
  $('#btn-copy').hidden = !isHost; $('#btn-present').hidden = !isHost;
  for (const t of ['A', 'B']) {
    const e = $('#team-' + t);
    e.querySelector('.team-name').textContent = s.teamNames[t];
    e.querySelector('.team-score').textContent = s.scores[t];
    e.classList.toggle('control', s.control === t);
  }
  $('#bank').textContent = s.bank;
  $('#mult').textContent = s.mult > 1 ? '×' + s.mult : '';
  $('#qcount').textContent = s.qNum ? 'Round ' + s.qNum + ' / ' + s.total : '';

  $('#question').textContent = s.phase === 'lobby' ? 'Waiting for the host to start…'
    : s.phase === 'gameover' ? gameOverText(s) : s.question;

  renderBanner(s);
  renderBoard(s);
  renderStrikes(s);
  renderFeed(s);
  if (isHost) renderHost(s); else renderPlayer(s);
  detectEvents(s);
  prev = s;
}

function gameOverText(s) {
  const a = s.scores.A, b = s.scores.B;
  if (a === b) return 'It\'s a tie at ' + a + '!';
  return (a > b ? s.teamNames.A : s.teamNames.B) + ' win ' + Math.max(a, b) + ' – ' + Math.min(a, b) + '!';
}

function renderBanner(s) {
  const b = $('#banner'); b.className = 'banner'; b.textContent = '';
  if (s.phase === 'steal') { b.className = 'banner steal'; b.textContent = 'STEAL! ' + s.teamNames[other(s.control)] + ' get one guess'; }
  else if (s.buzz) { b.className = 'banner buzzed'; b.textContent = '🔔 ' + s.buzz.name + ' (' + s.teamNames[s.buzz.team] + ') buzzed first!'; }
  else if (s.buzzOpen) b.textContent = 'Buzzers are OPEN…';
}

function renderBoard(s) {
  const board = $('#board'); board.replaceChildren();
  board.hidden = !s.answers.length;
  s.answers.forEach((a, i) => {
    const slot = el('div', 'slot');
    if (a.revealed) {
      slot.classList.add('revealed');
      if (prev && prev.answers[i] && !prev.answers[i].revealed) slot.classList.add('flip');
      slot.append(el('span', 'txt', a.text), el('span', 'pts', a.points));
    } else slot.append(el('span', 'num', i + 1));
    board.append(slot);
  });
}

function renderStrikes(s) {
  const box = $('#strikes'); box.replaceChildren();
  for (let i = 0; i < 3; i++) box.append(el('div', 'x' + (i < s.strikes ? ' on' : ''), '✕'));
}

function renderFeed(s) {
  const ul = $('#feed'); ul.replaceChildren();
  s.feed.forEach(f => { const li = el('li', f.team); li.append(el('b', null, f.name + ':'), document.createTextNode(f.text)); ul.append(li); });
}

function detectEvents(s) {
  if (!prev) return;
  if (s.strikes > prev.strikes) { sfx.strike(); const x = $('#xflash'); x.hidden = false; x.style.animation = 'none'; void x.offsetWidth; x.style.animation = ''; setTimeout(() => x.hidden = true, 900); }
  const nowR = s.answers.filter(a => a.revealed).length, prevR = prev.answers.filter(a => a.revealed).length;
  if (nowR > prevR && s.qNum === prev.qNum) sfx.ding();
  if (s.buzz && (!prev.buzz || prev.buzz.id !== s.buzz.id)) sfx.buzz();
  if (s.phase === 'gameover' && prev.phase !== 'gameover') sfx.win();
}

/* ---------- player panel ---------- */
function renderPlayer(s) {
  $('#player-panel').hidden = false; $('#host-panel').hidden = true;
  const me = s.players.find(p => p.id === myId);
  const mt = $('#my-team');
  if (me) { mt.className = 'my-team ' + me.team; mt.textContent = me.name + ' — Team ' + s.teamNames[me.team]; }
  $('#btn-buzz').disabled = !s.buzzOpen;
  $('#btn-buzz').textContent = s.buzzOpen ? 'BUZZ!' : (s.buzz ? 'LOCKED' : 'BUZZ');
}

/* ---------- host panel ---------- */
function renderHost(s) {
  const P = $('#host-panel'); P.hidden = false; $('#player-panel').hidden = true;
  P.replaceChildren();
  const btn = (label, cls, fn, disabled) => { const b = el('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; if (disabled) b.disabled = true; return b; };

  // flow
  const flow = el('div', 'row'); flow.append(el('h3', null, 'Flow'));
  if (s.phase === 'lobby') flow.append(btn('▶ Start game', 'primary', () => act('start')));
  else if (s.phase !== 'gameover') {
    flow.append(btn(s.buzzOpen ? 'Close buzzers' : 'Open buzzers (B)', s.buzzOpen ? 'danger' : 'primary', () => act(s.buzzOpen ? 'closeBuzz' : 'openBuzz')));
    flow.append(btn('✕ Strike (X)', 'danger', () => act('strike')));
    flow.append(btn(s.qNum >= s.total ? 'Finish game' : 'Next question ▶', '', () => act('next')));
  } else flow.append(el('span', 'muted', 'Refresh the page to start a new game.'));
  P.append(flow);

  if (s.answers.length && s.phase !== 'lobby') {
    // control
    const ctl = el('div', 'row'); ctl.append(el('h3', null, 'Control'));
    ctl.append(btn(s.teamNames.A + ' in control', 'amber', () => act('control', 'A')));
    ctl.append(btn(s.teamNames.B + ' in control', 'sapphire', () => act('control', 'B')));
    P.append(ctl);

    // answers
    const ah = el('div', 'row'); ah.append(el('h3', null, 'Answers (click or press 1–8)')); P.append(ah);
    const grid = el('div', 'ans-grid');
    H.answers.forEach((a, i) => {
      const b = btn((i + 1) + '. ' + a.text + '  (' + a.points + ')', a.revealed ? 'done' : '', () => act('reveal', i));
      grid.append(b);
    });
    P.append(grid);

    // award
    const aw = el('div', 'row'); aw.append(el('h3', null, 'Award bank (' + s.bank + ' × ' + s.mult + ' = ' + (s.bank * s.mult) + ')'));
    aw.append(btn('→ ' + s.teamNames.A, 'amber', () => act('award', 'A')));
    aw.append(btn('→ ' + s.teamNames.B, 'sapphire', () => act('award', 'B')));
    P.append(aw);
  }

  // players
  const pl = el('div', 'row'); pl.append(el('h3', null, 'Players (' + s.players.length + ') — click to swap team'));
  if (!s.players.length) pl.append(el('span', 'muted', 'Nobody has joined yet. Share the room code or invite link.'));
  s.players.forEach(p => { const c = el('span', 'chip ' + p.team, p.name); c.onclick = () => act('swap', p.id); pl.append(c); });
  P.append(pl);

  // misc
  const misc = el('div', 'row'); misc.append(el('h3', null, 'Misc'));
  misc.append(btn('Rename teams', 'small', () => act('rename')), btn('Reset scores', 'small', () => act('resetScores')), btn('Clear answer feed', 'small', () => act('clearFeed')));
  P.append(misc);
}

/* =====================================================================
   WIRING
   ===================================================================== */
$('#btn-host').onclick = () => { if (!room) startHost(); };
$('#btn-join').onclick = () => {
  const code = clean($('#in-code').value, 4).toUpperCase(), name = clean($('#in-name').value);
  if (code.length !== 4) return homeMsg('Enter the 4-letter room code.');
  if (!name) return homeMsg('Enter your name.');
  if (!room) joinGame(code, name);
};
$('#btn-buzz').onclick = () => { if (role === 'player') sendUp({ t: 'buzz' }); };
$('#answer-form').onsubmit = e => {
  e.preventDefault();
  const v = clean($('#in-answer').value, 60);
  if (v && role === 'player') { sendUp({ t: 'answer', text: v }); $('#in-answer').value = ''; toast('Sent to host'); }
};
$('#btn-copy').onclick = () => {
  const url = location.origin + location.pathname + '?room=' + pub.code;
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Invite link copied'), () => toast(url));
};
function togglePresent() { document.body.classList.toggle('presenting'); }
$('#btn-present').onclick = togglePresent;
document.addEventListener('keydown', e => {
  if (role !== 'host' || /INPUT|TEXTAREA/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k >= '1' && k <= '8') act('reveal', Number(k) - 1);
  else if (k === 'x') act('strike');
  else if (k === 'b') act(pub && pub.buzzOpen ? 'closeBuzz' : 'openBuzz');
  else if (k === 'h') togglePresent();
});
// prefill from invite link
const qp = new URLSearchParams(location.search).get('room');
if (qp) { $('#in-code').value = qp.toUpperCase().slice(0, 4); $('#in-name').focus(); }
