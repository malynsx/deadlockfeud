'use strict';
/* Deadlock Feud — host-authoritative game over PeerJS (WebRTC).
   The host's browser is the "server". Players connect with a 4-letter room code. */

const PREFIX = 'dlfeud-';
const $ = s => document.querySelector(s);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const clean = (s, n = 20) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

let peer = null, role = null, myId = null, hostConn = null;
const conns = new Map();     // host only: peerId -> DataConnection
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
function startHost() {
  homeMsg('Opening room…');
  const code = makeCode();
  peer = new Peer(PREFIX + code);
  peer.on('open', () => { role = 'host'; myId = peer.id; initHost(code); enterGame(); });
  peer.on('error', e => {
    if (e.type === 'unavailable-id') { try { peer.destroy(); } catch (_) {} startHost(); }
    else homeMsg('Could not open a room (' + e.type + '). Check your connection and try again.');
  });
  peer.on('connection', c => {
    c.on('data', d => onHostData(c, d));
    c.on('close', () => dropPlayer(c.peer));
    c.on('error', () => dropPlayer(c.peer));
  });
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
  const msg = { t: 'state', s: pub };
  conns.forEach(c => { try { c.send(msg); } catch (_) {} });
  render();
}

function onHostData(c, d) {
  if (!d || typeof d !== 'object') return;
  let p = H.players.find(x => x.id === c.peer);
  if (d.t === 'join') {
    conns.set(c.peer, c);
    if (!p) {
      const nA = H.players.filter(x => x.team === 'A').length, nB = H.players.length - nA;
      p = { id: c.peer, name: clean(d.name) || 'Player', team: nA <= nB ? 'A' : 'B' };
      H.players.push(p);
    } else p.name = clean(d.name) || p.name;
    broadcast();
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
  conns.delete(id);
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
function joinGame(code, name) {
  homeMsg('Connecting…');
  peer = new Peer();
  peer.on('open', id => {
    myId = id;
    hostConn = peer.connect(PREFIX + code, { reliable: true });
    hostConn.on('open', () => { role = 'player'; hostConn.send({ t: 'join', name }); });
    hostConn.on('data', d => { if (d && d.t === 'state') { pub = d.s; if (role === 'player') { enterGame(); } render(); } });
    hostConn.on('close', () => toast('Disconnected from host — refresh to rejoin'));
    hostConn.on('error', () => toast('Connection error'));
  });
  peer.on('error', e => {
    homeMsg(e.type === 'peer-unavailable' ? 'Room not found. Check the code.' : 'Connection problem (' + e.type + ').');
  });
  setTimeout(() => { if (!pub) homeMsg('Still trying… if this hangs, the room code may be wrong or your network may block peer connections.'); }, 9000);
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
$('#btn-host').onclick = startHost;
$('#btn-join').onclick = () => {
  const code = clean($('#in-code').value, 4).toUpperCase(), name = clean($('#in-name').value);
  if (code.length !== 4) return homeMsg('Enter the 4-letter room code.');
  if (!name) return homeMsg('Enter your name.');
  joinGame(code, name);
};
$('#btn-buzz').onclick = () => { if (hostConn && hostConn.open) hostConn.send({ t: 'buzz' }); };
$('#answer-form').onsubmit = e => {
  e.preventDefault();
  const v = clean($('#in-answer').value, 60);
  if (v && hostConn && hostConn.open) { hostConn.send({ t: 'answer', text: v }); $('#in-answer').value = ''; toast('Sent to host'); }
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
