'use strict';
/* Question editor. Questions are saved in this browser (localStorage) and can be exported
   to / imported from a .json file to move them between devices or back them up. */

const QStore = (() => {
  const KEY = 'dlfeud.questions.v1';
  const DEFAULTS = JSON.parse(JSON.stringify(window.QUESTIONS || []));
  const MAX_ANSWERS = 8;

  // Accepts our own format; drops anything malformed rather than failing the whole list.
  function normalize(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const item of list) {
      if (!item || typeof item.q !== 'string' || !Array.isArray(item.a)) continue;
      const a = item.a
        .filter(x => Array.isArray(x) && String(x[0] || '').trim())
        .slice(0, MAX_ANSWERS)
        .map(([t, p]) => [String(t).trim().slice(0, 40), Math.max(0, Math.min(100, Math.round(Number(p) || 0)))]);
      if (item.q.trim() && a.length) out.push({ q: item.q.trim().slice(0, 140), a, on: item.on !== false });
    }
    return out;
  }

  function load() {
    try {
      const saved = normalize(JSON.parse(localStorage.getItem(KEY)));
      if (saved && saved.length) return saved;
    } catch (_) { /* storage blocked or corrupt: fall back to the defaults */ }
    return normalize(DEFAULTS);
  }
  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (_) { return false; }
  }
  function isCustom() { try { return !!localStorage.getItem(KEY); } catch (_) { return false; } }
  function reset() { try { localStorage.removeItem(KEY); } catch (_) {} return normalize(DEFAULTS); }

  return { load, save, reset, normalize, isCustom, MAX_ANSWERS };
})();

const QEditor = (() => {
  let draft = [], dirty = false, onDone = null;
  const root = () => document.getElementById('editor');
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const button = (label, cls, fn, title) => { const b = mk('button', 'btn ' + (cls || ''), label); b.type = 'button'; b.onclick = fn; if (title) b.title = title; return b; };
  const touch = () => { dirty = true; root().querySelector('.ed-status').textContent = 'Unsaved changes'; };

  function open(done) {
    onDone = done || null;
    draft = JSON.parse(JSON.stringify(QStore.load()));
    dirty = false;
    root().hidden = false;
    document.body.classList.add('editing');
    draw();
    root().querySelector('.ed-list').scrollTop = 0;
  }

  function close(force) {
    if (!force && dirty && !confirm('Close without saving your changes?')) return;
    root().hidden = true;
    document.body.classList.remove('editing');
  }

  function saveAndClose() {
    const clean = QStore.normalize(draft);
    const dropped = draft.length - clean.length;
    if (!clean.length) return alert('Add at least one question with an answer first.');
    if (dropped && !confirm(dropped + ' question(s) have no question text or no answers and will be left out. Save anyway?')) return;
    clean.forEach(q => q.a.sort((x, y) => y[1] - x[1])); // the board lists the top answer first
    if (!QStore.save(clean)) alert('This browser would not let the page save. Use Export to keep a copy.');
    window.QUESTIONS = clean;
    dirty = false;
    close(true);
    if (onDone) onDone(clean);
  }

  function exportFile() {
    const blob = new Blob([JSON.stringify(QStore.normalize(draft), null, 2)], { type: 'application/json' });
    const a = mk('a'); a.href = URL.createObjectURL(blob); a.download = 'deadlock-feud-questions.json';
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function importFile() {
    const inp = mk('input'); inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      let list;
      try { list = QStore.normalize(JSON.parse(await f.text())); } catch (_) { list = null; }
      if (!list || !list.length) return alert('That file has no questions this editor can read.');
      if (confirm('Replace your ' + draft.length + ' questions with the ' + list.length + ' in this file?\nCancel adds them at the end instead.')) draft = list;
      else draft = draft.concat(list);
      touch(); draw();
    };
    inp.click();
  }

  function draw() {
    const R = root(); R.replaceChildren();
    const panel = mk('div', 'ed-panel');

    const head = mk('div', 'ed-head');
    const titles = mk('div');
    titles.append(mk('p', 'ed-kicker', 'Host tools'), mk('h2', null, 'Question editor'));
    const on = draft.filter(q => q.on !== false).length;
    titles.append(mk('p', 'ed-sub', draft.length + ' questions, ' + on + ' in the game. Saved in this browser.'));
    const acts = mk('div', 'ed-acts');
    acts.append(button('Import', 'small ghost', importFile, 'Load questions from a .json file'),
      button('Export', 'small ghost', exportFile, 'Download these questions as a .json file'),
      button('Reset to defaults', 'small ghost', () => { if (confirm('Throw away your questions and go back to the built-in set?')) { draft = QStore.reset(); touch(); draw(); } }));
    head.append(titles, acts);

    const list = mk('div', 'ed-list');
    draft.forEach((item, qi) => list.append(card(item, qi)));
    const add = button('Add a question', 'ed-add', () => {
      draft.push({ q: '', a: [['', 30], ['', 20]], on: true }); touch(); draw();
      const cards = root().querySelectorAll('.ed-q'); const last = cards[cards.length - 1];
      last.scrollIntoView({ block: 'center' }); last.querySelector('textarea').focus();
    });
    list.append(add);

    const foot = mk('div', 'ed-foot');
    foot.append(mk('span', 'ed-status', dirty ? 'Unsaved changes' : ''), button('Cancel', 'ghost', () => close()), button('Save questions', 'primary', saveAndClose));

    panel.append(head, list, foot);
    R.append(panel);
  }

  function card(item, qi) {
    const c = mk('section', 'ed-q' + (item.on === false ? ' off' : ''));
    const top = mk('div', 'ed-qtop');
    top.append(mk('span', 'num-ring', qi + 1));
    const tog = mk('label', 'ed-toggle');
    const cb = mk('input'); cb.type = 'checkbox'; cb.checked = item.on !== false;
    cb.onchange = () => { item.on = cb.checked; c.classList.toggle('off', !cb.checked); touch(); };
    tog.append(cb, document.createTextNode('In the game'));
    const tools = mk('div', 'ed-qtools');
    const move = d => () => { const j = qi + d; if (j < 0 || j >= draft.length) return; [draft[qi], draft[j]] = [draft[j], draft[qi]]; touch(); draw(); };
    tools.append(button('Up', 'small ghost', move(-1)), button('Down', 'small ghost', move(1)),
      button('Copy', 'small ghost', () => { draft.splice(qi + 1, 0, JSON.parse(JSON.stringify(item))); touch(); draw(); }),
      button('Delete', 'small ghost', () => { if (!item.q.trim() || confirm('Delete "' + item.q.slice(0, 60) + '"?')) { draft.splice(qi, 1); touch(); draw(); } }));
    top.append(tog, tools);

    const ta = mk('textarea'); ta.rows = 2; ta.maxLength = 140; ta.value = item.q; ta.placeholder = 'Name something…';
    ta.setAttribute('aria-label', 'Question ' + (qi + 1));
    ta.oninput = () => { item.q = ta.value; touch(); };

    const rows = mk('ol', 'ed-answers');
    const total = mk('p', 'ed-total');
    const sum = () => { const t = item.a.reduce((s, x) => s + (Number(x[1]) || 0), 0); total.textContent = 'Points add up to ' + t + (t === 100 ? '' : ' (aim for about 100)'); };
    item.a.forEach((ans, ai) => {
      const li = mk('li');
      const t = mk('input'); t.value = ans[0]; t.maxLength = 40; t.placeholder = 'Answer'; t.setAttribute('aria-label', 'Answer ' + (ai + 1));
      t.oninput = () => { ans[0] = t.value; touch(); };
      const p = mk('input'); p.type = 'number'; p.min = 0; p.max = 100; p.value = ans[1]; p.className = 'ed-pts'; p.setAttribute('aria-label', 'Points');
      p.oninput = () => { ans[1] = Number(p.value) || 0; touch(); sum(); };
      const del = button('Remove', 'small ghost', () => { item.a.splice(ai, 1); touch(); draw(); });
      del.disabled = item.a.length <= 1;
      li.append(t, p, del); rows.append(li);
    });
    sum();
    const addA = button('Add an answer', 'small ghost', () => { item.a.push(['', 5]); touch(); draw(); });
    addA.disabled = item.a.length >= QStore.MAX_ANSWERS;

    const bottom = mk('div', 'ed-qfoot'); bottom.append(total, addA);
    c.append(top, ta, rows, bottom);
    return c;
  }

  return { open, isOpen: () => !root().hidden };
})();

window.QUESTIONS = QStore.load();
