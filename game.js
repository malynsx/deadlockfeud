'use strict';
/* Deadlock Feud — host-authoritative game relayed through public servers over WebSockets.
   The host's browser is the "server". Players connect with a 4-letter room code.
   The host can also run the game from a phone remote, which gets the answers on a private topic. */

// Everyone connects to every relay they can reach, so host and players always share one.
// The MQTT brokers use ports 8884/8084, which some networks and VPNs block; the Nostr relays
// run on the normal HTTPS port 443, so at least those get through.
const RELAYS = [
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://nos.lol', nostr: true },
  { url: 'wss://relay.primal.net', nostr: true },
  { url: 'wss://relay.snort.social', nostr: true },
  { url: 'wss://nostr.mom', nostr: true },
  { url: 'wss://offchain.pub', nostr: true }
];
const TOPIC = code => 'dlfeud/v2/' + code;
const $ = s => document.querySelector(s);
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
const clean = (s, n = 20) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const randId = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

let clients = [], room = null, role = null, seq = 0, lastSeq = -1, sent = 0;
const handled = new Set();   // host only: message ids already acted on (each arrives once per broker)
const myId = randId(8);
const seen = new Map();      // host only: playerId -> last time we heard from them
let H = null;                // host only: full private state
let pub = null, prev = null; // public state (what everybody sees)
let remoteKey = null, priv = null, lastPriv = -1; // phone remote only

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
function toast(t) { const e = $('#toast'); e.textContent = t; e.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => e.hidden = true, 3200); }
function enterGame() { $('#home').hidden = true; $('#game').hidden = false; document.body.classList.add('in-game', 'role-' + role); }
const makeCode = () => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: 4 }, () => c[Math.floor(Math.random() * c.length)]).join(''); };
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pageUrl = () => location.origin + location.pathname;
const other = t => t === 'A' ? 'B' : 'A';

/* =====================================================================
   NETWORK
   ===================================================================== */
// A Nostr relay dressed up as an MQTT client: topics become a "t" tag on ephemeral events,
// which relays pass on to subscribers without storing them. There's no retained message,
// so the host re-sends state whenever someone joins.
const NOSTR_KIND = 21021;
let nostrKey = null, lastSigned = null; // signing is the slow part on phones, so each message is signed once for all relays
class NostrRelay {
  constructor(url) { this.url = url; this.h = {}; this.topics = new Set(); this.open = false; this.ended = false; this.connect(); }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); }
  emit(ev, ...a) { (this.h[ev] || []).forEach(fn => fn(...a)); }
  connect() {
    const ws = this.ws = new WebSocket(this.url);
    ws.onopen = () => { this.open = true; this.resubscribe(); this.emit('connect'); };
    ws.onmessage = e => {
      let d; try { d = JSON.parse(e.data); } catch (_) { return; }
      if (d[0] !== 'EVENT' || !d[2] || d[2].kind !== NOSTR_KIND) return;
      const t = (d[2].tags.find(x => x[0] === 't') || [])[1];
      if (this.topics.has(t)) this.emit('message', t, d[2].content);
    };
    ws.onerror = () => this.emit('error', new Error('websocket error'));
    ws.onclose = () => { this.open = false; this.emit('close'); if (!this.ended) setTimeout(() => this.connect(), 3000); };
  }
  resubscribe() { if (this.open && this.topics.size) this.ws.send(JSON.stringify(['REQ', 'dlf', { kinds: [NOSTR_KIND], '#t': [...this.topics] }])); }
  subscribe(topic) { this.topics.add(topic); this.resubscribe(); }
  publish(topic, payload) {
    if (!this.open) return;
    nostrKey = nostrKey || NostrTools.generateSecretKey();
    const content = String(payload);
    if (!lastSigned || lastSigned.topic !== topic || lastSigned.content !== content) {
      const ev = NostrTools.finalizeEvent({ kind: NOSTR_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['t', topic]], content }, nostrKey);
      lastSigned = { topic, content, msg: JSON.stringify(['EVENT', ev]) };
    }
    this.ws.send(lastSigned.msg);
  }
  end() { this.ended = true; try { this.ws.close(); } catch (_) {} }
}

// Resolves once the first relay connects; later ones are added to `clients` as they come up.
// onUp(client) runs on every (re)connect of each relay.
const diag = {}; // why each relay failed, shown with the error so problems can be reported
const haveLibs = () => window.mqtt || window.NostrTools;
function connectAll(will, onUp, onMessage) {
  return new Promise((resolve, reject) => {
    let pending = RELAYS.length, done = false;
    const fail = () => { if (--pending === 0 && !done) { done = true; reject(); } };
    RELAYS.forEach((r, i) => {
      const name = r.url.split('/')[2];
      let c, ok = false;
      try {
        if (r.nostr) { if (!window.NostrTools) throw new Error('nostr library did not load'); c = new NostrRelay(r.url); }
        else { if (!window.mqtt) throw new Error('mqtt library did not load'); c = mqtt.connect(r.url, { clientId: 'dlf_' + myId + '_' + i, will, reconnectPeriod: 3000, connectTimeout: 8000 }); }
      } catch (e) { diag[name] = e.message; return fail(); }
      const t = setTimeout(() => { if (!ok) { diag[name] = diag[name] || 'timed out'; c.end(true); fail(); } }, 9000);
      c.on('error', e => { if (!ok) diag[name] = 'error ' + (e && e.message || e); });
      c.on('close', () => { if (!ok && !diag[name]) diag[name] = 'closed by network'; });
      c.on('message', onMessage);
      c.on('connect', () => {
        onUp(c);
        if (ok) return;
        ok = true; clearTimeout(t); clients.push(c); delete diag[name];
        if (!done) { done = true; resolve(); }
      });
    });
  });
}
const publishAll = (topic, payload, opts) => clients.forEach(c => { try { c.publish(topic, payload, opts); } catch (_) {} });
const NO_SERVER = 'Could not reach the game server. A browser extension, firewall or VPN may be blocking it. Try another browser or network.';

// Shows the error plus what failed, and checks whether this browser can open WebSockets at all.
function connectError() {
  homeMsg(NO_SERVER);
  const lines = haveLibs() ? Object.entries(diag).map(([k, v]) => k + ': ' + v) : ['the connection libraries did not load (blocked or missing)'];
  const box = el('pre', 'diag', lines.join('\n') + '\nWebSocket test: checking…');
  $('#home-msg').append(box);
  let ws, settled = false;
  const done = r => { if (settled) return; settled = true; box.textContent = box.textContent.replace('checking…', r); try { ws.close(); } catch (_) {} };
  try { ws = new WebSocket('wss://ws.postman-echo.com/raw'); ws.onopen = () => done('works'); ws.onerror = () => done('blocked'); } catch (_) { done('blocked'); }
  setTimeout(() => done('timed out'), 6000);
}

function sendUp(d) {
  if (room) publishAll(room + '/up', JSON.stringify(Object.assign({ from: myId, m: ++sent }, d)), { qos: 1 });
}

/* =====================================================================
   HOST
   ===================================================================== */
async function startHost() {
  if (!haveLibs()) return connectError();
  homeMsg('Opening room…');
  const code = makeCode();
  room = TOPIC(code);
  const onUp = c => { c.subscribe(room + '/up', { qos: 1 }); if (H) broadcast(); };
  const onMsg = (t, m) => { if (t === room + '/up') { try { onHostData(JSON.parse(m)); } catch (_) {} } };
  try { await connectAll({ topic: room + '/state', payload: '', retain: true, qos: 1 }, onUp, onMsg); }
  catch (_) { room = null; return connectError(); }
  role = 'host';
  initHost(code);
  addEventListener('pagehide', () => {
    publishAll(room + '/state', '', { retain: true });
    publishAll(room + '/ctl/' + H.remoteKey, '', { retain: true });
  });
  setInterval(() => seen.forEach((t, id) => { if (Date.now() - t > 20000) dropPlayer(id); }), 5000);
  enterGame();
  broadcast();
}

function initHost(code) {
  H = {
    code, remoteKey: randId(10), remoteOn: false, history: [],
    order: newOrder(), qNum: 0, q: null, turn: { A: 0, B: 0 }, react: null, reactSeq: 0,
    answers: [], strikes: 0, bank: 0, scores: { A: 0, B: 0 },
    teamNames: { A: 'Amber', B: 'Sapphire' }, control: null,
    buzzOpen: false, buzz: null, phase: 'lobby', players: [], feed: []
  };
}

const mult = () => !H || H.qNum <= 3 ? 1 : H.qNum <= 6 ? 2 : 3;
// questions switched off in the editor are skipped
const newOrder = () => shuffle(window.QUESTIONS.map((q, i) => q.on === false ? -1 : i).filter(i => i >= 0));

/* ---------- heroes: whose turn it is, and who reacts to a reveal or strike ---------- */
const HERO_BY_ID = Object.fromEntries((window.HEROES || []).map(h => [h.id, h]));
const membersOf = t => H.players.filter(p => p.team === t);
const memberAt = t => { const m = membersOf(t); return m.length ? m[H.turn[t] % m.length] : null; };
function react(kind, player) {
  const hero = player && HERO_BY_ID[player.hero];
  if (!hero) return;
  const lines = (hero.lines && hero.lines[kind]) || [];
  H.react = { n: ++H.reactSeq, team: player.team, pid: player.id, hero: hero.id, kind, line: lines.length ? Math.floor(Math.random() * lines.length) : -1 };
}
// The player answering right now: the buzzer in a face-off, then team members in turn.
function answerer() {
  if (H.phase === 'faceoff') return H.buzz ? H.players.find(p => p.id === H.buzz.id) : null;
  if (H.phase === 'play') return memberAt(H.control);
  if (H.phase === 'steal') return memberAt(other(H.control));
  return null;
}

function publicState() {
  return {
    code: H.code, phase: H.phase, qNum: H.qNum, total: H.order.length, mult: mult(),
    question: H.q ? H.q.q : '',
    answers: H.answers.map(a => a.revealed ? { revealed: true, text: a.text, points: a.points } : { revealed: false }),
    strikes: H.strikes, bank: H.bank, scores: H.scores, teamNames: H.teamNames,
    control: H.control, buzzOpen: H.buzzOpen, buzz: H.buzz, canUndo: H.history.length > 0,
    players: H.players.map(p => ({ id: p.id, name: p.name, team: p.team, hero: p.hero || null })),
    up: H.phase === 'play' || H.phase === 'steal' ? { A: (memberAt('A') || {}).id || null, B: (memberAt('B') || {}).id || null } : null,
    react: H.react,
    feed: H.feed.slice(-8)
  };
}

function broadcast() {
  pub = publicState();
  publishAll(room + '/state', JSON.stringify({ t: 'state', n: ++seq, s: pub }), { qos: 1, retain: true });
  // the phone remote needs the hidden answers; only it knows this topic
  publishAll(room + '/ctl/' + H.remoteKey, JSON.stringify({ n: seq, answers: H.answers }), { qos: 1, retain: true });
  render();
}

function onHostData(d) {
  if (!d || typeof d !== 'object' || !H) return;
  const id = clean(d.from, 16); if (!id) return;
  if (d.m) { const key = id + ':' + d.m; if (handled.has(key)) return; handled.add(key); }
  if (d.t === 'ctl') return onRemote(d);
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
  } else if (d.t === 'hero') {
    const hero = HERO_BY_ID[d.id] ? d.id : null;
    // taken by someone else: re-send state so their picker shows it as taken
    if (!(hero && H.players.some(x => x.hero === hero && x.id !== p.id))) p.hero = hero;
    broadcast();
  } else if (d.t === 'answer') {
    const text = clean(d.text, 60);
    if (text) { H.feed.push({ name: p.name, team: p.team, text }); if (H.feed.length > 30) H.feed.shift(); broadcast(); }
  }
}

function onRemote(d) {
  if (d.key !== H.remoteKey) return;
  if (d.a === 'hello') {
    if (!H.remoteOn) {
      H.remoteOn = true;
      document.body.classList.add('presenting');
      toast('Phone remote connected. Controls are hidden here, press H to show them.');
    }
    return broadcast();
  }
  if (Object.prototype.hasOwnProperty.call(actions, d.a)) act(d.a, d.v);
}

function dropPlayer(id) {
  if (!H) return;
  seen.delete(id);
  const i = H.players.findIndex(p => p.id === id);
  if (i >= 0) { H.players.splice(i, 1); broadcast(); }
}

// Game actions can be undone; roster and housekeeping actions can't.
const UNDOABLE = new Set(['start', 'next', 'openBuzz', 'closeBuzz', 'control', 'reveal', 'strike', 'award', 'steal', 'resetScores']);
const SNAP_KEYS = ['qNum', 'q', 'answers', 'strikes', 'bank', 'scores', 'control', 'buzzOpen', 'buzz', 'phase', 'turn'];
const isTeam = t => t === 'A' || t === 'B';

const actions = {
  start() { actions.next(); },
  next() {
    if (H.qNum >= H.order.length) {
      H.phase = 'gameover'; H.q = null; H.answers = []; H.buzzOpen = false; H.buzz = null; H.control = null;
      const { A, B } = H.scores; if (A !== B) react('gloat', memberAt(A > B ? 'A' : 'B'));
      return;
    }
    H.q = window.QUESTIONS[H.order[H.qNum]]; H.qNum++;
    H.answers = H.q.a.slice(0, 8).map(([text, points]) => ({ text, points, revealed: false }));
    H.strikes = 0; H.bank = 0; H.control = null; H.buzz = null; H.buzzOpen = false; H.phase = 'faceoff';
  },
  openBuzz() { if (!H.q || H.phase !== 'faceoff') return; H.buzz = null; H.buzzOpen = true; },
  closeBuzz() { H.buzzOpen = false; },
  control(team) { if (!isTeam(team) || !H.q) return; H.control = team; H.buzzOpen = false; if (H.phase === 'faceoff') { H.phase = 'play'; H.strikes = 0; } },
  reveal(i) {
    const a = H.answers[i]; if (!a || a.revealed || !H.q || H.phase === 'roundover') return;
    a.revealed = true; H.bank += a.points;
    const who = answerer(); react('gloat', who);
    if (H.phase === 'play' && who) H.turn[H.control]++;
  },
  strike() {
    if (!H.q || !['faceoff', 'play', 'steal'].includes(H.phase)) return;
    H.strikes = Math.min(3, H.strikes + 1);
    const who = answerer(); react('critical', who);
    if (H.phase === 'play' && who) H.turn[H.control]++;
    if (H.strikes >= 3 && H.phase === 'play') H.phase = 'steal';
  },
  award(team) {
    if (!isTeam(team) || !H.q || H.phase === 'roundover') return;
    H.scores[team] += H.bank * mult(); H.bank = 0;
    H.answers.forEach(a => a.revealed = true);
    H.phase = 'roundover'; H.buzzOpen = false;
  },
  steal(worked) { if (H.phase === 'steal' && isTeam(H.control)) actions.award(worked ? other(H.control) : H.control); },
  undo() {
    const snap = H.history.pop(); if (!snap) return;
    Object.assign(H, JSON.parse(snap));
  },
  restart() {
    Object.assign(H, { order: newOrder(), qNum: 0, q: null, answers: [], strikes: 0, bank: 0, turn: { A: 0, B: 0 },
      scores: { A: 0, B: 0 }, control: null, buzzOpen: false, buzz: null, phase: 'lobby', feed: [], history: [] });
  },
  swap(id) { const p = H.players.find(x => x.id === id); if (p) p.team = other(p.team); },
  renameTeam(v) { if (v && isTeam(v.team)) { const n = clean(v.name, 14); if (n) H.teamNames[v.team] = n; } },
  resetScores() { H.scores = { A: 0, B: 0 }; },
  clearFeed() { H.feed = []; }
};

function act(name, arg) {
  if (role !== 'host' || !H || !actions[name]) return;
  if (UNDOABLE.has(name)) {
    H.history.push(JSON.stringify(Object.fromEntries(SNAP_KEYS.map(k => [k, H[k]]))));
    if (H.history.length > 30) H.history.shift();
  }
  actions[name](arg);
  broadcast();
}

// Host screen runs actions directly; the phone remote sends them to the host.
function cmd(name, arg) {
  if (role === 'host') act(name, arg);
  else if (role === 'remote') {
    sendUp({ t: 'ctl', key: remoteKey, a: name, v: arg });
    // show a reveal straight away; the host's next update confirms it
    if (name === 'reveal' && priv && priv.answers[arg]) { priv.answers[arg].revealed = true; render(); }
  }
}

/* =====================================================================
   PLAYER + REMOTE
   ===================================================================== */
function onStateMessage(m) {
  if (!m.length) { if (pub) toast('The host left, so the game has ended'); return false; }
  let d; try { d = JSON.parse(m); } catch (_) { return false; }
  if (d.t !== 'state' || d.n <= lastSeq) return false; // same state arrives once per broker
  lastSeq = d.n; pub = d.s;
  return true;
}

async function joinGame(code, name) {
  if (!haveLibs()) return connectError();
  homeMsg('Connecting…');
  room = TOPIC(code);
  const onUp = c => { c.subscribe(room + '/state', { qos: 1 }); c.publish(room + '/up', JSON.stringify({ from: myId, t: 'join', name }), { qos: 1 }); };
  const onMsg = (t, m) => {
    if (t !== room + '/state' || !onStateMessage(m)) return;
    if (role !== 'player') { role = 'player'; homeMsg(''); enterGame(); }
    render();
  };
  try { await connectAll({ topic: room + '/up', payload: JSON.stringify({ t: 'leave', from: myId }), qos: 0 }, onUp, onMsg); }
  catch (_) { room = null; return connectError(); }
  setInterval(() => sendUp({ t: 'join', name }), 5000);
  addEventListener('pagehide', () => sendUp({ t: 'leave' }));
  setTimeout(() => { if (!pub) homeMsg('Room not found. Check the code with your host.'); }, 7000);
}

async function joinRemote(code, key) {
  if (!haveLibs()) return connectError();
  homeMsg('Connecting the remote…');
  room = TOPIC(code); remoteKey = key;
  const onUp = c => { c.subscribe(room + '/state', { qos: 1 }); c.subscribe(room + '/ctl/' + key, { qos: 1 }); };
  const onMsg = (t, m) => {
    if (t === room + '/ctl/' + key) {
      let d; try { d = JSON.parse(m); } catch (_) { return; }
      if (!d || d.n <= lastPriv) return;
      lastPriv = d.n; priv = d;
    } else if (t !== room + '/state' || !onStateMessage(m)) return;
    if (pub && priv && role !== 'remote') { role = 'remote'; homeMsg(''); enterGame(); }
    render();
  };
  try { await connectAll(undefined, onUp, onMsg); }
  catch (_) { room = null; return connectError(); }
  sendUp({ t: 'ctl', key, a: 'hello' });
  setTimeout(() => { if (role !== 'remote') homeMsg('This remote link has expired. Open a new one from the host screen.'); }, 7000);
}

/* =====================================================================
   RENDER (shared)
   ===================================================================== */
const PHASE = { lobby: 'Lobby', faceoff: 'Face-off', play: 'Playing', steal: 'Steal', roundover: 'Round over', gameover: 'Game over' };
const MULT_LABEL = { 2: 'Double points', 3: 'Triple points' };

function render() {
  if (!pub) return;
  const s = pub, controls = role === 'host' || role === 'remote';
  $('#room-code').textContent = s.code;
  $('#phase-label').textContent = role === 'remote' ? 'Phone remote' : (PHASE[s.phase] || '');
  $('#btn-copy').hidden = role !== 'host'; $('#btn-present').hidden = role !== 'host';

  document.body.dataset.phase = s.phase;
  preloadHeroes(s.players);
  noteReaction(s);
  for (const t of ['A', 'B']) renderTicket(s, t);
  $('#bank').textContent = s.bank;
  $('#mult').textContent = s.mult > 1 ? 'x' + s.mult : '';

  $('#lobby').hidden = s.phase !== 'lobby';
  $('#round').hidden = s.phase === 'lobby';
  if (s.phase === 'lobby') renderLobby(s);
  else renderRound(s);

  if (controls) renderHost(s); else { renderPlayer(s); renderPicker(s); }
  detectEvents(s);
  prev = s;
}

/* ---------- team tickets: portrait of whoever is up, team faces, and hero reactions ---------- */
const REACT_MS = 4200;
let liveReact = null; // { n, until } of the reaction currently on screen

function noteReaction(s) {
  const r = s.react;
  if (!r || (liveReact && liveReact.n === r.n)) return;
  liveReact = { n: r.n, until: Date.now() + REACT_MS };
  if (!prev) { liveReact.until = 0; return; } // don't replay an old reaction on join
  setTimeout(() => { if (pub) render(); }, REACT_MS + 50);
  const hero = HERO_BY_ID[r.hero], line = hero && hero.lines[r.kind] && hero.lines[r.kind][r.line];
  if (role === 'host' && line) setTimeout(() => playVoice(line.audio), r.kind === 'gloat' ? 120 : 220); // one speaker: only the big screen
}

// Fetch reaction portraits (everyone) and voice lines (big screen) as soon as a hero is picked,
// so the first gloat or strike shows and sounds without a download in between.
const preloaded = new Set(), voices = {};
function preloadHeroes(players) {
  players.forEach(p => {
    const h = HERO_BY_ID[p.hero]; if (!h || preloaded.has(h.id)) return;
    preloaded.add(h.id);
    [h.gloat, h.critical].forEach(src => { if (src) new Image().src = src; });
    if (role === 'host') ['gloat', 'critical'].forEach(k => (h.lines[k] || []).forEach(l => { const a = new Audio(l.audio); a.preload = 'auto'; voices[l.audio] = a; }));
  });
}
function playVoice(src) {
  const a = voices[src] || (voices[src] = new Audio(src));
  try { a.currentTime = 0; } catch (_) {}
  a.volume = .9; a.play().catch(() => {});
}

function setImg(img, src) { if (img.getAttribute('src') !== src) { if (src) img.src = src; else img.removeAttribute('src'); } }

function faceEl(player, active) {
  const hero = player && HERO_BY_ID[player.hero];
  const f = el('span', 'mini' + (active ? ' up' : '') + (hero ? '' : ' blank'));
  f.title = player.name + (hero ? ' (' + hero.name + ')' : '');
  if (hero) { const i = el('img'); i.src = hero.card; i.alt = ''; i.loading = 'lazy'; f.append(i); }
  else f.textContent = player.name.slice(0, 1).toUpperCase();
  return f;
}

function renderTicket(s, t) {
  const e = $('#team-' + t);
  e.querySelector('.team-name').textContent = s.teamNames[t];
  e.querySelector('.team-score').textContent = s.scores[t];
  e.querySelector('.ticket-note').textContent = s.control === t ? (s.phase === 'steal' ? 'Defending' : 'In control') : (s.phase === 'steal' && s.control ? 'Stealing' : '');
  e.classList.toggle('control', s.control === t);

  const members = s.players.filter(p => p.team === t);
  const r = s.react && s.react.team === t && liveReact && liveReact.n === s.react.n && Date.now() < liveReact.until ? s.react : null;
  const upId = s.up && s.up[t];
  // the big portrait: whoever is reacting, else whoever is answering, else the first player with a hero
  const face = r ? members.find(p => p.id === r.pid) || { hero: r.hero, name: '' }
    : members.find(p => p.id === upId) || members.find(p => p.hero) || members[0];
  const hero = face && HERO_BY_ID[face.hero];
  e.classList.toggle('has-face', !!hero);
  e.classList.toggle('gloat', !!(r && r.kind === 'gloat')); e.classList.toggle('critical', !!(r && r.kind === 'critical'));
  setImg(e.querySelector('.t-face img'), hero ? (r && hero[r.kind]) || hero.card : '');

  const kicker = r ? (r.kind === 'gloat' ? 'Survey says yes' : 'Strike') : upId && face && face.id === upId ? 'Answering' : members.length ? 'On the team' : 'Waiting for players';
  e.querySelector('.t-kicker').textContent = kicker;
  e.querySelector('.t-player').textContent = face ? face.name : '';
  e.querySelector('.t-hero').textContent = hero ? hero.name : face ? 'No hero yet' : '';

  const roster = e.querySelector('.t-roster'); roster.replaceChildren();
  members.forEach(p => {
    const c = el('span', 'r-chip' + (p.id === upId ? ' up' : '') + (face && p.id === face.id ? ' shown' : ''));
    c.append(faceEl(p), el('span', 'r-name', p.name));
    roster.append(c);
  });

  const say = $('#say-' + t), line = r && hero && hero.lines[r.kind] && hero.lines[r.kind][r.line];
  say.hidden = !line;
  say.className = 't-say paper ' + (r ? r.kind : '');
  if (line) { say.querySelector('b').textContent = hero.name; say.querySelector('span').textContent = line.text; }
}

/* ---------- hero picker (players) ---------- */
let myPick = null, quoteAudio = null;
function renderPicker(s) {
  const me = s.players.find(p => p.id === myId);
  const P = $('#picker');
  P.hidden = !window.HEROES || !me || !(s.phase === 'lobby' || !me.hero);
  if (P.hidden) return;
  const mine = me.hero || myPick;
  const grid = $('#hero-grid');
  if (!grid.children.length) {
    window.HEROES.forEach(h => {
      const b = el('button', 'hero'); b.type = 'button'; b.dataset.id = h.id;
      const i = el('img'); i.src = h.card; i.alt = ''; i.loading = 'lazy';
      b.append(i, el('span', 'hero-name', h.name), el('span', 'hero-taken'));
      b.onclick = () => pickHero(h);
      grid.append(b);
    });
  }
  const takenBy = Object.fromEntries(s.players.filter(p => p.hero && p.id !== myId).map(p => [p.hero, p.name]));
  [...grid.children].forEach(b => {
    const by = takenBy[b.dataset.id];
    b.classList.toggle('mine', b.dataset.id === mine);
    b.disabled = !!by;
    b.querySelector('.hero-taken').textContent = by || '';
  });
  const h = HERO_BY_ID[mine], q = $('#hero-quote');
  q.hidden = !h;
  if (h) q.replaceChildren(el('b', null, h.name), document.createTextNode(h.quote ? ' ' + h.quote : ''));
  $('#picker-note').textContent = mine ? 'Tap another portrait to switch.' : 'Tap a portrait. Each hero can only be picked once.';
}
function pickHero(h) {
  myPick = h.id; sendUp({ t: 'hero', id: h.id });
  if (quoteAudio) quoteAudio.pause();
  if (h.quoteAudio) { quoteAudio = new Audio(h.quoteAudio); quoteAudio.play().catch(() => {}); }
  if (pub) renderPicker(pub);
}

let qrFor = null;
function renderLobby(s) {
  const join = pageUrl() + '?room=' + s.code;
  if (qrFor !== join && window.QRCode) {
    qrFor = join; $('#qr').replaceChildren();
    new QRCode($('#qr'), { text: join, width: 256, height: 256, colorDark: '#1b1512', colorLight: '#efe2c8', correctLevel: QRCode.CorrectLevel.M });
  }
  $('#join-url').textContent = pageUrl().replace(/^https?:\/\//, '').replace(/\/$/, '');
  $('#join-code').textContent = s.code;
  for (const t of ['A', 'B']) {
    $('#roster-name-' + t).textContent = s.teamNames[t];
    const ul = $('#roster-' + t); ul.replaceChildren();
    const names = s.players.filter(p => p.team === t);
    if (!names.length) ul.append(el('li', 'empty', 'Nobody yet'));
    names.forEach(p => { const li = el('li', p.id === myId ? 'me' : ''); li.append(faceEl(p), el('span', null, p.name)); ul.append(li); });
  }
}

function renderRound(s) {
  $('#qcount').textContent = s.phase === 'gameover' ? 'Final scores' : 'Question ' + s.qNum + ' of ' + s.total;
  $('#qmult').hidden = !(s.mult > 1 && s.phase !== 'gameover');
  $('#qmult').textContent = MULT_LABEL[s.mult] || '';
  $('#question').textContent = s.phase === 'gameover' ? gameOverText(s) : s.question;

  const b = $('#banner'); b.className = 'banner'; b.textContent = '';
  if (s.phase === 'steal') { b.className = 'banner tag t-orange'; b.textContent = s.teamNames[other(s.control)] + ' can steal with one guess'; }
  else if (s.buzz && s.phase === 'faceoff') { b.className = 'banner tag t-yellow'; b.textContent = s.buzz.name + ' buzzed in for ' + s.teamNames[s.buzz.team]; }
  else if (s.buzzOpen) { b.className = 'banner tag t-ink'; b.textContent = 'Buzzers are open'; }

  const board = $('#board'); board.replaceChildren();
  board.hidden = !s.answers.length;
  board.style.setProperty('--rows', Math.ceil(s.answers.length / 2)); // 1-4 down the left, 5-8 down the right
  s.answers.forEach((a, i) => {
    const slot = el('div', 'slot');
    if (a.revealed) {
      slot.classList.add('revealed');
      if (prev && prev.qNum === s.qNum && prev.answers[i] && !prev.answers[i].revealed) slot.classList.add('just');
      slot.append(el('span', 'txt', a.text), el('span', 'pts', a.points));
    } else slot.append(el('span', 'num', i + 1));
    board.append(slot);
  });

  const box = $('#strikes'); box.replaceChildren();
  box.hidden = s.phase === 'gameover';
  for (let i = 0; i < 3; i++) box.append(el('div', 'x' + (i < s.strikes ? ' on' : ''), 'X'));
}

function gameOverText(s) {
  const a = s.scores.A, b = s.scores.B;
  if (a === b) return 'A tie at ' + a + ' points';
  return (a > b ? s.teamNames.A : s.teamNames.B) + ' win, ' + Math.max(a, b) + ' to ' + Math.min(a, b);
}

function detectEvents(s) {
  if (!prev) return;
  if (s.strikes > prev.strikes && s.qNum === prev.qNum) {
    sfx.strike();
    const x = $('#xflash'); x.hidden = false; x.style.animation = 'none'; void x.offsetWidth; x.style.animation = '';
    clearTimeout(detectEvents.t); detectEvents.t = setTimeout(() => x.hidden = true, 800);
  }
  const nowR = s.answers.filter(a => a.revealed).length, prevR = prev.answers.filter(a => a.revealed).length;
  if (nowR > prevR && s.qNum === prev.qNum && s.phase !== 'roundover') sfx.ding();
  if (s.buzz && (!prev.buzz || prev.buzz.id !== s.buzz.id)) sfx.buzz();
  if (s.phase === 'gameover' && prev.phase !== 'gameover') sfx.win();
}

/* ---------- player ---------- */
function renderPlayer(s) {
  $('#player-panel').hidden = false; $('#host-panel').hidden = true;
  const me = s.players.find(p => p.id === myId);
  const mt = $('#my-team');
  if (me) { mt.className = 'my-team ' + me.team; mt.replaceChildren(el('span', 'muted', 'You are on'), el('span', 'tag ' + (me.team === 'A' ? 't-orange' : 't-teal'), s.teamNames[me.team])); }
  const buzz = $('#btn-buzz');
  buzz.disabled = !s.buzzOpen;
  buzz.textContent = s.buzzOpen ? 'Buzz' : s.buzz && s.phase === 'faceoff' ? (s.buzz.id === myId ? 'You buzzed' : 'Locked') : 'Wait';
  buzz.classList.toggle('mine', !!(s.buzz && s.buzz.id === myId && s.phase === 'faceoff'));
}

/* ---------- host controls ---------- */
const openSections = new Set(['answers']);
const teamCls = t => t === 'A' ? 'amber' : 'sapphire';

// What the host should do next, as a title, a sentence and the buttons for it.
function nextStep(s, answers) {
  const n = s.teamNames, c = s.control, worth = s.bank * s.mult;
  const allOut = answers.length && answers.every(a => a.revealed);
  const B = (label, a, v, cls = 'primary', key) => ({ label, a, v, cls, key });
  switch (s.phase) {
    case 'lobby':
      if (!s.total) return { title: 'No questions yet', text: 'Every question is switched off. Open Game, then Edit questions, and switch some on.', btns: [] };
      return { title: 'Waiting for players', text: s.players.length ? s.players.length + ' joined. Start when everyone is in.' : 'Players scan the code on screen, or open the site and type ' + s.code + '.',
        btns: [B('Start the game', 'start', null, 'primary', 'N')] };
    case 'faceoff':
      if (s.buzzOpen) return { title: 'Buzzers are open', text: 'Waiting for the first buzz.', btns: [B('Close buzzers', 'closeBuzz', null, '', 'B')] };
      if (s.buzz) return { title: s.buzz.name + ' buzzed first', text: 'Hear their answer and reveal it below if it is on the board. Then pick the team that plays this round.',
        btns: [B(n.A + ' play', 'control', 'A', 'amber'), B(n.B + ' play', 'control', 'B', 'sapphire'), B('Reopen buzzers', 'openBuzz', null, 'ghost', 'B')] };
      return { title: 'Face-off', text: 'Read the question out loud, then open the buzzers.',
        btns: [B('Open buzzers', 'openBuzz', null, 'primary', 'B'), B(n.A + ' play', 'control', 'A', 'ghost'), B(n.B + ' play', 'control', 'B', 'ghost')] };
    case 'play':
      if (allOut) return { title: 'Board cleared', text: n[c] + ' found every answer.', btns: [B('Give ' + worth + ' to ' + n[c], 'award', c, teamCls(c), 'N')] };
      return { title: n[c] + ' are playing', text: 'Reveal correct answers. Strike wrong ones. Three strikes and ' + n[other(c)] + ' can steal.',
        btns: [B('Strike ' + (s.strikes + 1), 'strike', null, 'danger', 'X'), B('Give ' + worth + ' to ' + n[c], 'award', c, 'ghost')] };
    case 'steal':
      return { title: n[other(c)] + ' steal', text: 'They get one guess. If it is on the board, reveal it, then choose what happened.',
        btns: [B('Steal worked, ' + worth + ' to ' + n[other(c)], 'steal', true, teamCls(other(c))), B('Steal failed, ' + worth + ' to ' + n[c], 'steal', false, teamCls(c))] };
    case 'roundover':
      return { title: 'Round over', text: s.qNum >= s.total ? 'That was the last question.' : 'Next up: question ' + (s.qNum + 1) + ' of ' + s.total + (s.qNum + 1 > 3 && s.mult === 1 ? ', worth double.' : s.qNum + 1 > 6 && s.mult === 2 ? ', worth triple.' : '.'),
        btns: [B(s.qNum >= s.total ? 'Show final scores' : 'Next question', 'next', null, 'primary', 'N')] };
    case 'gameover':
      return { title: 'Game over', text: gameOverText(s) + '.', btns: [B('Play again', 'restart', null, 'primary')] };
  }
  return { title: '', text: '', btns: [] };
}

function renderHost(s) {
  const P = $('#host-panel'); P.hidden = false; $('#player-panel').hidden = true;
  // don't rebuild under someone typing a team name
  if (P.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const answers = role === 'host' ? H.answers : (priv ? priv.answers : []);
  P.replaceChildren();
  const btn = (label, cls, fn, key) => {
    const b = el('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.onclick = fn;
    if (key && role === 'host') b.append(el('kbd', null, key));
    return b;
  };
  const section = (id, title, meta) => {
    const d = el('details', 'hsec'); d.open = openSections.has(id);
    d.ontoggle = () => d.open ? openSections.add(id) : openSections.delete(id);
    const sum = el('summary', null, title); if (meta != null) sum.append(el('span', 'meta', meta));
    d.append(sum); P.append(d); return d;
  };

  // next step
  const step = nextStep(s, answers);
  const card = el('div', 'step paper');
  card.append(el('p', 'step-kicker', 'Next step'), el('h3', null, step.title), el('p', 'step-text', step.text));
  // on the remote the question is off-screen, so show it here to read out
  if (role === 'remote' && s.question && s.phase !== 'gameover') card.prepend(el('p', 'step-q', s.question));
  const row = el('div', 'step-btns');
  step.btns.forEach(b => row.append(btn(b.label, b.cls, () => cmd(b.a, b.v), b.key)));
  card.append(row);
  P.append(card);

  // answer key
  if (answers.length) {
    const sec = section('answers', 'Answer key', role === 'host' ? 'press 1 to ' + answers.length : 'tap to reveal');
    const list = el('ol', 'key');
    answers.forEach((a, i) => {
      const li = el('li', a.revealed ? 'out' : '');
      const b = el('button', null); b.type = 'button'; b.disabled = a.revealed || s.phase === 'roundover';
      b.append(el('span', 'k-num', i + 1), el('span', 'k-txt', a.text), el('span', 'k-pts', a.points));
      b.onclick = () => cmd('reveal', i);
      li.append(b); list.append(li);
    });
    sec.append(list);
  }

  // tools
  const tools = el('div', 'tools');
  if (['faceoff', 'play', 'steal'].includes(s.phase)) tools.append(btn('Strike', 'small danger', () => cmd('strike'), 'X'));
  const undo = btn('Undo', 'small', () => cmd('undo'), 'U'); undo.disabled = !s.canUndo;
  tools.append(undo);
  if (s.phase !== 'lobby' && s.phase !== 'gameover' && s.phase !== 'roundover') {
    tools.append(btn('Skip question', 'small ghost', () => { if (confirm('Skip this question without scoring it?')) cmd('next'); }));
  }
  P.append(tools);

  // typed answers
  if (s.feed.length) {
    const sec = section('feed', 'Typed answers', s.feed.length);
    const ul = el('ul', 'feed');
    s.feed.slice().reverse().forEach(f => { const li = el('li', f.team); li.append(el('b', null, f.name), document.createTextNode(f.text)); ul.append(li); });
    sec.append(ul, btn('Clear', 'small ghost', () => cmd('clearFeed')));
  }

  // teams
  const tsec = section('teams', 'Teams and players', s.players.length);
  for (const t of ['A', 'B']) {
    const box = el('div', 'team-edit ' + teamCls(t));
    const inp = el('input'); inp.value = s.teamNames[t]; inp.maxLength = 14; inp.setAttribute('aria-label', 'Team name');
    inp.onchange = () => cmd('renameTeam', { team: t, name: inp.value });
    inp.onkeydown = e => { if (e.key === 'Enter') inp.blur(); };
    const chips = el('div', 'chips');
    const mine = s.players.filter(p => p.team === t);
    if (!mine.length) chips.append(el('span', 'muted', 'Nobody yet'));
    mine.forEach(p => { const c = el('button', 'chip'); c.type = 'button'; c.title = 'Move to the other team'; c.append(faceEl(p), el('span', null, p.name)); c.onclick = () => cmd('swap', p.id); chips.append(c); });
    box.append(inp, chips); tsec.append(box);
  }
  tsec.append(el('p', 'hint', 'Click a name to move it to the other team.'));

  // phone remote (host screen only)
  if (role === 'host') {
    const rsec = section('remote', 'Run it from your phone', H.remoteOn ? 'connected' : null);
    const url = pageUrl() + '?room=' + s.code + '&remote=' + H.remoteKey;
    rsec.append(el('p', 'hint', 'The remote shows the answers, so keep this QR to yourself. Once it connects, the controls hide on this screen.'));
    const qbox = el('div', 'remote-qr'); qbox.hidden = !showRemoteQr;
    if (showRemoteQr && window.QRCode) new QRCode(qbox, { text: url, width: 180, height: 180, colorDark: '#1b1512', colorLight: '#efe2c8', correctLevel: QRCode.CorrectLevel.M });
    const r = el('div', 'tools');
    r.append(btn(showRemoteQr ? 'Hide QR' : 'Show QR', 'small', () => { showRemoteQr = !showRemoteQr; render(); }),
      btn('Copy remote link', 'small ghost', () => copy(url, 'Remote link copied')));
    rsec.append(qbox, r);
  }

  // game
  const gsec = section('game', 'Game');
  const g = el('div', 'tools');
  g.append(btn('Reset scores', 'small ghost', () => { if (confirm('Reset both scores to 0?')) cmd('resetScores'); }),
    btn('New game', 'small ghost', () => { if (confirm('Start over from the lobby? Scores reset and players stay.')) cmd('restart'); }));
  if (role === 'host' && (s.phase === 'lobby' || s.phase === 'gameover')) {
    g.prepend(btn('Edit questions', 'small', () => QEditor.open(() => { H.order = newOrder(); broadcast(); toast('Questions saved'); })));
  }
  gsec.append(g);
  if (role === 'host') gsec.append(el('p', 'hint', 'Keys: 1 to 8 reveal, X strike, B buzzers, N next step, U undo, H hide controls.'));
}
let showRemoteQr = false;

function copy(text, msg) {
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast(msg), () => toast(text));
}

/* =====================================================================
   WIRING
   ===================================================================== */
$('#btn-host').onclick = () => { if (!room) startHost(); };
function questionInfo() {
  const on = window.QUESTIONS.filter(q => q.on !== false).length;
  $('#q-info').textContent = on + ' question' + (on === 1 ? '' : 's') + ' ready' + (QStore.isCustom() ? ', your own set.' : ', the built-in set.');
}
$('#btn-edit').onclick = () => QEditor.open(questionInfo);
questionInfo();
$('#btn-join').onclick = () => {
  const code = clean($('#in-code').value, 4).toUpperCase(), name = clean($('#in-name').value);
  if (code.length !== 4) return homeMsg('Enter the 4-letter room code.');
  if (!name) return homeMsg('Enter your name.');
  if (!room) joinGame(code, name);
};
$('#in-name').onkeydown = e => { if (e.key === 'Enter') $('#btn-join').click(); };
$('#btn-buzz').onclick = () => {
  if (role !== 'player') return;
  sendUp({ t: 'buzz' });
  const b = $('#btn-buzz'); b.textContent = 'Sent'; b.disabled = true; // feedback now; the host's answer decides who was first
};
$('#answer-form').onsubmit = e => {
  e.preventDefault();
  const v = clean($('#in-answer').value, 60);
  if (v && role === 'player') { sendUp({ t: 'answer', text: v }); $('#in-answer').value = ''; toast('Sent to the host'); }
};
$('#btn-copy').onclick = () => copy(pageUrl() + '?room=' + pub.code, 'Invite link copied');
function togglePresent() { document.body.classList.toggle('presenting'); }
$('#btn-present').onclick = togglePresent;
document.addEventListener('keydown', e => {
  if (role !== 'host' || QEditor.isOpen() || /INPUT|TEXTAREA/.test(e.target.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k >= '1' && k <= '8') act('reveal', Number(k) - 1);
  else if (k === 'x') act('strike');
  else if (k === 'b') act(pub.buzzOpen ? 'closeBuzz' : 'openBuzz');
  else if (k === 'u') act('undo');
  else if (k === 'h') togglePresent();
  else if (k === 'n') { const b = nextStep(pub, H.answers).btns.find(x => x.key === 'N'); if (b) act(b.a, b.v); }
});

// links: ?room=CODE prefills the join form, ?room=CODE&remote=KEY opens the phone remote
const params = new URLSearchParams(location.search);
const qRoom = clean(params.get('room'), 4).toUpperCase(), qRemote = clean(params.get('remote'), 16);
if (qRoom && qRemote) joinRemote(qRoom, qRemote);
else if (qRoom) { $('#in-code').value = qRoom; $('#in-name').focus(); }
