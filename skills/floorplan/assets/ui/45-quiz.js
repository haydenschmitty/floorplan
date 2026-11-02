// Quiz: multiple-choice questions that check the map was understood, one at a time, with the card that
// shows each answer highlighted after answering. Starter questions come from graph.quiz (written by Claude
// in architecture.json). A start screen picks how deep to go: Big picture (the main parts, as on the
// overview) or In detail (files, endpoints and the parts inside), and keeps your best score for each.
// With the Ask bar connected, the agent writes more (the quiz mode in graph-query.js): at the chosen
// level, about one card (right-click or its details: Quiz me on this), or about recent work, to check
// you can explain a change. New questions last until the page is closed. Talks to the viewer only
// through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  if (!SC) return;
  const G = SC.graph;
  const { h } = SC;
  const A = SC.agent || { id: 'claude', name: 'Claude', app: 'Claude Code', cli: 'the Claude Code CLI' };
  const Cap = (t) => t[0].toUpperCase() + t.slice(1);
  const canAsk = () => !SC.exported && !!SC.askEngine();

  // ---------- questions ----------
  const norm = (s) => String(s ?? '').trim();
  /** A question as the quiz keeps it, or null when it can't be asked: 2-4 different choices, the answer among them, a card that exists. */
  function clean(x) {
    const choices = [...new Set((Array.isArray(x?.choices) ? x.choices : []).map(norm).filter(Boolean))].slice(0, 4);
    const q = norm(x?.q ?? x?.question), answer = norm(x?.answer), ref = norm(x?.ref ?? x?.id);
    if (!q || choices.length < 2 || !choices.includes(answer) || !SC.exists(ref) || givesAway(q, answer)) return null;
    return { q, choices, answer, ref, explain: norm(x.explain) };
  }
  /** "Which part handles payments?" → "Payments": the answer is right there in the question. */
  const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  function givesAway(q, answer) {
    const a = words(answer);
    return a.length >= 3 && ` ${words(q)} `.includes(` ${a} `);
  }
  // the same question asked twice, whatever its punctuation, in any language
  const key = (x) => x.q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const pool = [];
  /** Adds the questions that are new and askable, and returns them. */
  function add(list) {
    const seen = new Set(pool.map(key)), added = [];
    for (const x of list) {
      const c = clean(x);
      if (c && !seen.has(key(c))) { seen.add(key(c)); pool.push(c); added.push(c); }
    }
    return added;
  }
  add(G.quiz || []);
  if (!pool.length && SC.exported) return; // an exported copy has no agent to write questions
  const about = (id) => pool.filter((x) => x.ref === id || SC.chain(x.ref).includes(id));
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };

  // ---------- levels: how deep a question goes, from the card that answers it ----------
  // Big picture: a card on the overview (a main part or an outside service). In detail: anything inside one.
  const LEVELS = [
    { id: 'big', label: 'Big picture', hint: 'The main parts and how they connect' },
    { id: 'detail', label: 'Details', hint: 'Files, endpoints and the smaller parts inside' },
    { id: 'all', label: 'Mixed', hint: 'Some of each' },
  ];
  // inside a chosen part, its big picture is the part itself and what sits directly in it
  const levelOf = (x, part = '') => (x.ref === part || (SC.parentOf(x.ref) || 'root') === (part || 'root') ? 'big' : 'detail');
  const atLevel = (level, part = '') => pool.filter((x) => level === 'all' || levelOf(x, part) === level);
  const LEVEL_ASK = {
    big: 'Ask about the main parts of the app (the top-level cards and outside services) and how they connect: what each is for, which talks to which, and what happens end to end. Use their ids.',
    detail: 'Ask about specific files and endpoints (f:... and r:... ids) and the smaller parts inside the main ones: what each does, what uses it, and what happens step by step.',
    all: '',
  };
  // the part of the app to be asked about: a main part or one inside it, or the whole app (''). The start
  // screen opens on what's in view (the part card selected, else the part being looked inside), and the
  // person can pick any other.
  const isPart = (id) => typeof id === 'string' && id.startsWith('n:') && id !== 'n:unassigned' && SC.exists(id);
  // every main part, each with all the parts inside it at any depth ("Server › Payments › Refunds")
  const kids = (id) => G.nodes.filter((c) => c.parent === id);
  const inside = (id, trail) => kids(id).flatMap((c) => {
    const name = trail ? `${trail} › ${c.label}` : c.label;
    return [{ id: 'n:' + c.id, name }, ...inside(c.id, name)];
  });
  const PARTS = G.nodes.filter((n) => !n.parent && n.id !== 'unassigned')
    .map((n) => ({ id: 'n:' + n.id, name: n.label, inside: inside(n.id, '').filter((p) => SC.exists(p.id)) }))
    .filter((p) => SC.exists(p.id));
  let picked = null; // the part picked on the start screen; null follows the map until then
  let draft = ''; // a topic being typed on the start screen
  function scope() {
    if (picked !== null) return picked;
    if (isPart(SC.state.selected)) return SC.state.selected;
    return isPart(SC.state.container) ? SC.state.container : '';
  }
  const inPart = (x, part) => !part || x.ref === part || SC.chain(x.ref).includes(part);
  const chosen = (level, part) => atLevel(level, part).filter((x) => inPart(x, part));
  const COUNTS = [5, 10, 20, 0]; // 0: all of them
  const PROJECT = G.project?.name || G.meta?.rootName || 'map';
  const prefs = {
    get level() { const l = SC.store.get('quiz-level:' + PROJECT, 'all'); return LEVELS.some((x) => x.id === l) ? l : 'all'; },
    set level(l) { SC.store.set('quiz-level:' + PROJECT, l); },
    get count() { const c = +SC.store.get('quiz-count:' + PROJECT, 10); return COUNTS.includes(c) ? c : 10; },
    set count(c) { SC.store.set('quiz-count:' + PROJECT, +c); },
    // the questions answered right at least once, so they're asked after the others
    right: () => new Set(SC.store.get('quiz-right:' + PROJECT, []) || []),
    gotRight(x) { const r = prefs.right(); if (r.has(key(x))) return; r.add(key(x)); SC.store.set('quiz-right:' + PROJECT, [...r].slice(-500)); },
  };
  /** As many as were asked for: the ones not answered right yet first, each group in a new order. */
  const pickFrom = (list, count = 0) => {
    const r = prefs.right();
    const all = [...shuffle(list.filter((x) => !r.has(key(x)))), ...shuffle(list.filter((x) => r.has(key(x))))];
    return count ? all.slice(0, count) : all;
  };
  const partName = (id) => SC.info(id)?.name || id;

  // recent work (graph.recent): the cards a change touched, and what was asked for
  const recent = (() => {
    const R = G.recent;
    const items = (R?.items || []).filter((it) => SC.exists(it.id));
    return items.length ? { tasks: R.tasks || [], items } : null;
  })();

  const style = document.createElement('style');
  style.textContent = `
#quiz { position: fixed; left: 16px; bottom: 76px; width: min(380px, calc(100vw - 32px)); max-height: calc(100vh - 160px); overflow: auto; padding: 16px 16px 12px 20px; border-radius: var(--r-panel); z-index: 6; animation: quizIn .4s var(--ease); }
#quiz[hidden] { display: none; }
#quiz .qk { font-size: 12px; color: var(--text-3); margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
#quiz .qk i { width: 3px; height: 3px; border-radius: 50%; background: var(--text-4); }
#quiz .qt { font-size: 16px; font-weight: 600; letter-spacing: -.01em; line-height: 1.35; padding-right: 22px; }
#quiz .qn { color: var(--text-2); line-height: 1.55; margin-top: 6px; font-size: 13.5px; }
#quiz .qn code { font-family: var(--mono); font-size: 12px; }
#quiz .qc { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
#quiz .qc button { display: flex; gap: 10px; align-items: baseline; width: 100%; min-height: 44px; padding: 9px 12px; border: 0; border-radius: 12px; background: rgba(var(--ink), .05); color: var(--text); font: inherit; font-size: 13.5px; line-height: 1.45; text-align: left; cursor: pointer; transition: background .2s var(--ease); }
#quiz .qc button:hover:not(:disabled) { background: rgba(var(--ink), .09); }
#quiz .qc button:disabled { cursor: default; }
#quiz .qc button .n { font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; flex: none; }
#quiz .qc button.right { background: var(--ok-bg); color: var(--ok-text); }
#quiz .qc button.wrong { background: color-mix(in srgb, var(--sev-high) 14%, transparent); }
#quiz .qc button.dim { opacity: .55; }
#quiz .qe { margin-top: 10px; padding: 10px 12px; border-radius: 12px; background: rgba(var(--ink), .04); font-size: 13px; line-height: 1.55; color: var(--text-2); }
#quiz .qe b { color: var(--text); }
#quiz .qe .on-map { display: block; margin-top: 4px; font-size: 12px; color: var(--text-3); }
#quiz .qp { margin-top: 10px; font-size: 12.5px; color: var(--text-3); display: flex; gap: 8px; align-items: center; }
#quiz .qp .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(var(--ink), .15); border-top-color: var(--text-2); animation: quizSpin .8s linear infinite; flex: none; }
#quiz .ql { display: flex; gap: 4px; margin-top: 12px; padding: 3px; border-radius: 12px; background: rgba(var(--ink), .05); }
#quiz .ql button { flex: 1; min-height: 44px; padding: 4px 6px; border: 0; border-radius: 9px; background: transparent; color: var(--text-2); font: inherit; font-size: 12.5px; line-height: 1.25; cursor: pointer; }
#quiz .ql button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-card); font-weight: 600; }
#quiz .ql.n button { font-variant-numeric: tabular-nums; }
#quiz .qlab { display: block; margin-top: 12px; font-size: 11.5px; color: var(--text-3); }
#quiz .qlab + .ql { margin-top: 4px; }
#quiz .qa input { width: 100%; min-height: 44px; padding: 0 10px; border: 0; border-radius: 10px; background: rgba(var(--ink), .05); color: var(--text); font: inherit; font-size: 13px; }
#quiz .qpick { width: 100%; min-height: 44px; margin-top: 4px; display: flex; align-items: center; gap: 8px; padding: 0 10px 0 12px; border: 0; border-radius: 12px; background: rgba(var(--ink), .05); color: var(--text); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; transition: background .15s var(--ease); }
#quiz .qpick:hover, #quiz .qpick[aria-expanded="true"] { background: rgba(var(--ink), .09); }
#quiz .qpick span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#quiz .qpick svg { color: var(--text-3); flex: none; transition: transform .2s var(--ease); }
#quiz .qpick[aria-expanded="true"] svg { transform: rotate(180deg); }
/* solid, not see-through like menus over the canvas: it opens over the quiz's own buttons */
#quiz-parts { position: fixed; z-index: 40; overflow: auto; overscroll-behavior: contain; min-width: 0; background: linear-gradient(var(--menu-solid), var(--menu-solid)), var(--bg); backdrop-filter: none; -webkit-backdrop-filter: none; }
#quiz-parts .mi { min-height: 44px; }
#quiz-parts .mi .pn { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#quiz-parts .mi.top { font-weight: 600; }
#quiz-parts .mi.sub { color: var(--text-2); }
#quiz-parts .mi.d1 { padding-left: 26px; }
#quiz-parts .mi.d2 { padding-left: 40px; }
#quiz-parts .mi.d3 { padding-left: 54px; }
#quiz-parts .mi.on { background: rgba(var(--ink), .08); color: var(--text); }
#quiz-parts .mi.on .pn::after { content: " ✓"; color: var(--text-3); font-weight: 400; }
#quiz-parts .mi:focus-visible { outline: none; background: rgba(var(--ink), .11); }
#quiz .qgo { width: 100%; height: 44px; margin-top: 14px; justify-content: center; }
#quiz .qor { display: flex; align-items: center; gap: 10px; margin: 14px 0 10px; font-size: 11.5px; color: var(--text-3); text-transform: uppercase; letter-spacing: .06em; }
#quiz .qor::before, #quiz .qor::after { content: ""; flex: 1; height: 1px; background: rgba(var(--ink), .12); }
#quiz .qa { display: flex; gap: 6px; }
#quiz .qa input { flex: 1; min-width: 0; padding: 0 12px; }
#quiz .qa input::placeholder { color: var(--text-3); }
#quiz .qa .btn { height: 44px; flex: none; }
#quiz .lnk { border: 0; padding: 0; background: none; color: var(--text-2); font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
#quiz .qh { margin-top: 8px; font-size: 12.5px; color: var(--text-3); line-height: 1.5; }
#quiz .qh b { color: var(--text-2); font-weight: 600; }
#quiz .qf { display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
#quiz .qf.end { justify-content: flex-end; }
#quiz .dots { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
#quiz .dots i { width: 14px; height: 3px; border-radius: 2px; background: rgba(var(--ink), .12); }
#quiz .dots i.ok { background: var(--ok); }
#quiz .dots i.no { background: var(--sev-high); }
#quiz .qf .btn { height: 32px; }
#quiz .qx { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; }
@keyframes quizIn { from { opacity: 0; transform: translateY(8px) scale(.98); } }
@keyframes quizSpin { to { transform: rotate(360deg); } }
`;
  document.head.appendChild(style);

  // ---------- card ----------
  const card = document.createElement('div');
  card.id = 'quiz';
  card.className = 'glass';
  card.hidden = true;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Quiz');
  card.dataset.floats = ''; // the map centers what it highlights beside or above this card, not under it
  document.body.appendChild(card);
  // what the card shows: the start screen (home), a round of questions, the agent writing more, or why it couldn't
  let home = false, round = null, loading = null, failed = null;
  const active = () => !card.hidden;

  const WHY = {
    no_engine: `New questions are written by ${A.app}. From the codebase root run <code>node floorplan/serve.mjs</code>${A.id === 'claude' ? ', or open this map in the Claude app' : ''}.`,
    cli_missing: `New questions need ${h(A.cli)}, which wasn't found on this computer.`,
    not_logged_in: `${h(Cap(A.cli))} needs you to sign in first.`,
    rate_limited: `${h(A.name)} is busy or you have hit a usage limit. Try again in a bit.`,
    quiz_empty: `${h(A.name)} didn't come back with questions that fit the map. Try again.`,
  };
  // the browser's own "Failed to fetch": the map's server stopped since the page was opened
  const failure = (e) => WHY[e?.code] || (e instanceof TypeError && window.FLOORPLAN_SERVER
    ? 'Couldn’t reach the map’s server, which may have stopped. Start it again with <code>node floorplan/serve.mjs</code> in the codebase, then reload this page.'
    : h(e?.message || 'Something went wrong.'));

  /** The card that shows an answer: highlighted where it sits, and moved into view clear of the quiz. */
  const show = (ref) => SC.reveal(ref);
  const score = () => round.list.filter((x) => x.picked === x.answer).length;
  const dots = () => `<div class="dots">${round.list.map((x) => `<i class="${x.picked == null ? '' : x.picked === x.answer ? 'ok' : 'no'}"></i>`).join('')}</div>`;
  const closeBtn = `<button class="btn icon qx" data-x title="Close (Esc)">${SC.iconI('x')}</button>`;
  const kicker = (...parts) => `<div class="qk">${['Quiz', ...parts.filter(Boolean)].map((p) => `<span>${h(p)}</span>`).join('<i></i>')}</div>`;
  const levelName = (id) => LEVELS.find((l) => l.id === id)?.label || '';
  /** The questions picked on the start screen: the part, the depth and how many, with the title saying which. */
  const startChosen = () => {
    const level = prefs.level, part = scope();
    const list = chosen(level, part);
    // req: what More questions on the score screen asks for, the same part and depth
    start(list, { kind: 'level', count: prefs.count < list.length ? prefs.count : 0, req: { level, ...(part ? { focus: part } : {}) }, title: [part && partName(part), level !== 'all' && levelName(level)].filter(Boolean).join(' · ') });
  };

  // the start screen: pick from the questions there are (part, depth, how many), or have the agent write
  // some on a topic of your own
  function renderHome() {
    const level = prefs.level, part = scope(), list = chosen(level, part);
    // only counts there are enough questions for, then all of them; a saved count that's too big means all
    const counts = [...COUNTS.filter((c) => c && c < list.length), 0];
    const count = counts.includes(prefs.count) ? prefs.count : 0;
    const ask = canAsk(), n = count || list.length;
    card.innerHTML = `${closeBtn}${kicker()}
      <div class="qt">Test yourself on ${h(part ? partName(part) : PROJECT)}</div>
      <span class="qlab" id="quiz-part-label">Part of the app</span>
      <button type="button" class="qpick" data-part aria-haspopup="listbox" aria-expanded="false" aria-labelledby="quiz-part-label quiz-part-now"><span id="quiz-part-now">${h(part ? partName(part) : 'The whole app')}</span><svg class="i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button>
      <span class="qlab">How deep</span>
      <div class="ql" role="radiogroup" aria-label="How deep">${LEVELS.map((l) => `<button role="radio" aria-checked="${l.id === level}" class="${l.id === level ? 'on' : ''}" data-level="${l.id}" title="${h(l.hint)}">${h(l.label)}</button>`).join('')}</div>
      ${counts.length > 1 ? `<span class="qlab">Questions</span>
      <div class="ql n" role="radiogroup" aria-label="How many questions">${counts.map((c) => `<button role="radio" aria-checked="${c === count}" class="${c === count ? 'on' : ''}" data-count="${c}">${c || `All ${list.length}`}</button>`).join('')}</div>` : ''}
      ${list.length ? `<button class="btn primary qgo" data-go>Start ${SC.plural(n, 'question')}</button>`
        : `<div class="qh">No ${{ big: 'big-picture ', detail: 'detailed ', all: '' }[level]}questions about ${h(part ? partName(part) : 'the app')} yet.${ask ? ` Write some below.` : SC.exported ? '' : ` ${window.FLOORPLAN_SERVER ? WHY.cli_missing : WHY.no_engine}`}</div>`}
      ${ask ? `<div class="qor">or</div>
      <form class="qa" data-topic><input name="t" maxlength="300" autocomplete="off" value="${h(draft)}" placeholder="Your own topic, e.g. sign-in" aria-label="Topic for new questions"><button class="btn soft" type="submit" title="${h(A.name)} writes new questions on this topic, or on the part and depth above if it's empty">${SC.iconI('spark')}Write</button></form>
      ${recent ? `<div class="qh">Or <button class="lnk" data-recent>quiz me on recent work</button>, to check you can explain what just changed.</div>` : ''}` : ''}`;
    const trigger = card.querySelector('[data-part]');
    trigger.onclick = () => (partsOpen() ? closeParts() : openParts());
    trigger.onkeydown = (ev) => { if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); openParts(); } };
    card.querySelectorAll('[data-level]').forEach((b) => b.onclick = () => { prefs.level = b.dataset.level; render(); });
    card.querySelectorAll('[data-count]').forEach((b) => b.onclick = () => { prefs.count = b.dataset.count; render(); });
    card.querySelector('[data-go]')?.addEventListener('click', startChosen);
    card.querySelector('[data-recent]')?.addEventListener('click', () => more({ recent: true }));
    // the agent writes questions on the typed topic (instead of the picks above), or on the part and depth
    // above when there's none. What's typed survives the card redrawing as the picks change.
    const form = card.querySelector('[data-topic]');
    form?.t.addEventListener('input', () => { draft = form.t.value; });
    form?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const asked = form.t.value.trim();
      draft = '';
      more(asked ? { asked } : { level: prefs.level, ...(scope() ? { focus: scope() } : {}) });
    });
  }

  // ---------- the part list: the map's own menu (glass, rows like the right-click menu), not the browser's ----------
  const pop = document.createElement('div');
  pop.id = 'quiz-parts';
  pop.className = 'menu glass';
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-label', 'Part of the app');
  document.body.appendChild(pop);
  const partsOpen = () => pop.classList.contains('open');
  const rows = () => [...pop.querySelectorAll('.mi')];
  function closeParts(refocus = true) {
    if (!partsOpen()) return;
    pop.classList.remove('open');
    const trigger = card.querySelector('[data-part]');
    trigger?.setAttribute('aria-expanded', 'false');
    if (refocus) trigger?.focus();
  }
  function openParts() {
    const trigger = card.querySelector('[data-part]');
    if (!trigger) return;
    const part = scope(), ask = canAsk();
    // a part is listed when it has questions, when new ones can be written, or when it's the one in use
    const listed = (p) => ask || p.id === part || chosen('all', p.id).length;
    const row = (id, name, cls) => {
      const c = id ? chosen('all', id).length : pool.length;
      return `<button type="button" class="mi ${cls}${id === part ? ' on' : ''}" role="option" aria-selected="${id === part}" data-id="${h(id)}"><span class="pn">${h(name)}</span>${c ? `<span class="hint">${c}</span>` : ''}</button>`;
    };
    // each main part, then the parts inside it, indented by how deep they sit
    pop.innerHTML = row('', 'The whole app', 'top') + PARTS.map((p) => {
      const sub = p.inside.filter(listed);
      if (!listed(p) && !sub.length) return '';
      return `<div class="mi-sep"></div>${row(p.id, p.name, 'top')}${sub.map((s) => {
        const trail = s.name.split(' › ');
        return row(s.id, trail[trail.length - 1], `sub d${Math.min(trail.length, 3)}`);
      }).join('')}`;
    }).join('');
    // under the button, or over it when there's more room above; never off screen
    const r = trigger.getBoundingClientRect(), below = innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 320 && above > below;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - Math.max(r.width, 260) - 8))}px`;
    pop.style.width = `${Math.max(r.width, 260)}px`;
    pop.style.maxHeight = `${Math.max(160, Math.min(420, up ? above : below))}px`;
    pop.style.top = up ? '' : `${r.bottom + 6}px`;
    pop.style.bottom = up ? `${innerHeight - r.top + 6}px` : '';
    pop.style.transformOrigin = up ? 'bottom left' : 'top left';
    pop.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    const on = pop.querySelector('.mi.on') || rows()[0];
    on?.focus();
    on?.scrollIntoView({ block: 'nearest' });
  }
  pop.addEventListener('click', (ev) => {
    const b = ev.target.closest('.mi');
    if (!b) return;
    picked = b.dataset.id;
    closeParts(false);
    render();
    card.querySelector('[data-part]')?.focus();
  });
  pop.addEventListener('keydown', (ev) => {
    const all = rows(), i = all.indexOf(document.activeElement);
    const go = (k) => { ev.preventDefault(); all[Math.max(0, Math.min(all.length - 1, k))]?.focus(); };
    if (ev.key === 'ArrowDown') go(i + 1);
    else if (ev.key === 'ArrowUp') go(i - 1);
    else if (ev.key === 'Home') go(0);
    else if (ev.key === 'End') go(all.length - 1);
    else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); ev.stopPropagation(); closeParts(); }
  });
  // a click anywhere else, or the window changing size, puts it away
  document.addEventListener('pointerdown', (ev) => { if (partsOpen() && !pop.contains(ev.target) && !ev.target.closest?.('[data-part]')) closeParts(false); }, true);
  window.addEventListener('resize', () => closeParts(false));

  function render() {
    if (partsOpen()) closeParts(false);
    if (loading) {
      card.innerHTML = `${closeBtn}${kicker()}<div class="qt">${h(loading.label)}</div>
        <div class="qp"><span class="spin"></span><span>${h(loading.lines[loading.lines.length - 1])}</span></div>
        <div class="qf end"><button class="btn" data-x>Stop</button></div>`;
    } else if (failed) {
      card.innerHTML = `${closeBtn}${kicker()}<div class="qt">${h(failed.title)}</div><div class="qn">${failed.html}</div>
        <div class="qf end">${failed.retry && canAsk() ? `<button class="btn soft" data-retry>Try again</button>` : ''}<button class="btn primary" data-home>Back</button></div>`;
    } else if (home) {
      renderHome();
    } else if (round.done) {
      const n = round.list.length, s = score(), missed = round.list.filter((x) => x.picked !== x.answer);
      const note = s === n ? 'Every one right. You know how this fits together.'
        : s >= n / 2 ? 'Most of the way there. The ones you missed are worth another look on the map.'
        : s ? 'Some right. Look at the cards for the ones you missed, then try them again.'
        : 'None right this time. The tour and the highlighted cards are a good place to start, then try again.';
      // at most two buttons: the close button already ends the quiz, and the Quiz button reopens the start
      const again = missed.length ? `<button class="btn primary" data-again>Retry ${missed.length === 1 ? 'the one' : `the ${missed.length}`} you missed</button>` : '';
      const more = canAsk() ? `<button class="btn ${missed.length ? 'soft' : 'primary'}" data-more>${SC.iconI('spark')}More questions</button>` : '';
      card.innerHTML = `${closeBtn}${kicker(round.title)}
        <div class="qt">You got ${s} of ${n} right</div><div class="qn">${note}</div>
        <div class="qf">${dots()}</div>
        <div class="qf end">${again}${more}${again && more ? '' : `<button class="btn${again || more ? '' : ' primary'}" data-home>Back</button>`}</div>`;
    } else {
      const x = round.list[round.at], last = round.at === round.list.length - 1, answered = x.picked != null;
      card.innerHTML = `${closeBtn}${kicker(`${round.at + 1} of ${round.list.length}`, round.title)}
        <div class="qt">${h(x.q)}</div>
        <div class="qc">${x.order.map((c, k) => {
          const cls = !answered ? '' : c === x.answer ? 'right' : c === x.picked ? 'wrong' : 'dim';
          return `<button data-pick="${k}" class="${cls}" ${answered ? 'disabled' : ''}><span class="n">${k + 1}</span><span>${h(c)}</span></button>`;
        }).join('')}</div>
        ${answered ? `<div class="qe"><b>${x.picked === x.answer ? 'Right.' : `Not quite. The answer is “${h(x.answer)}”.`}</b>${x.explain ? ` ${h(x.explain)}` : ''}<span class="on-map">Highlighted on the map: ${h(SC.info(x.ref)?.name || x.ref)}</span></div>` : ''}
        <div class="qf">${dots()}${answered ? `<button class="btn primary" data-next>${last ? 'See your score' : 'Next'}</button>` : `<button class="btn" data-skip>Skip</button>`}</div>`;
    }
    card.querySelectorAll('[data-x]').forEach((b) => b.onclick = close);
    card.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => pick(+b.dataset.pick));
    card.querySelector('[data-next]')?.addEventListener('click', next);
    card.querySelector('[data-skip]')?.addEventListener('click', next);
    if (!home) card.querySelector('[data-more]')?.addEventListener('click', () => more(round?.req || { level: prefs.level }));
    card.querySelector('[data-retry]')?.addEventListener('click', () => more(failed.req));
    card.querySelector('[data-home]')?.addEventListener('click', openHome);
    card.querySelector('[data-again]')?.addEventListener('click', () => start(round.list.filter((x) => x.picked !== x.answer), { kind: 'retry', title: round.title, req: round.req }));
    place();
  }
  // sit above the zoom controls, and above the Ask bar (and its notices) where they overlap
  function place() {
    let bottom = 76;
    const ask = document.getElementById('ask');
    if (ask) {
      const a = ask.getBoundingClientRect(), c = card.getBoundingClientRect();
      const top = [...ask.children].filter((x) => x.offsetParent && x.getBoundingClientRect().height > 0).reduce((m, x) => Math.min(m, x.getBoundingClientRect().top), a.bottom);
      if (a.width && a.left < 16 + c.width + 12 && top < innerHeight) bottom = Math.max(bottom, innerHeight - top + 12);
    }
    card.style.bottom = Math.min(bottom, Math.max(76, innerHeight - card.offsetHeight - 80)) + 'px';
  }
  window.addEventListener('resize', () => { if (active()) place(); });
  // an answer opening in the Ask bar grows upward: move out of its way, again once it has finished
  // sliding in (it's measured mid-animation the first time, lower than where it ends up)
  // (watching what changes in it, not its size: size observers don't run while the page isn't drawn)
  const replace = () => { if (active()) place(); };
  const askSheet = document.getElementById('ask-sheet');
  if (askSheet) {
    new MutationObserver(() => { replace(); setTimeout(replace, 450); }).observe(askSheet, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
    askSheet.addEventListener('animationend', replace);
    askSheet.addEventListener('transitionend', replace);
  }

  function pick(k) {
    const x = round?.list[round.at];
    if (!x || x.picked != null || !x.order[k]) return;
    x.picked = x.order[k];
    if (x.picked === x.answer) prefs.gotRight(x);
    render();
    show(x.ref);
  }
  function next() {
    if (!round || round.done) return;
    if (round.at < round.list.length - 1) { round.at++; render(); return; }
    round.done = true;
    render();
  }
  function openCard() { window.FloorplanTour?.end(); card.hidden = false; }
  function openHome() {
    home = true; round = null; loading = null; failed = null;
    openCard();
    render();
  }
  /** Asks these questions (count of them, or all), with their choices shuffled. kind: level (picked on the start screen), retry, focus, recent, new. */
  function start(list, { kind = 'new', count = 0, title = '', req = null } = {}) {
    if (!list.length) return;
    SC.stopFlow();
    home = false; loading = null; failed = null;
    round = { kind, req, title, at: 0, done: false,
      list: pickFrom(list, count).map((x) => ({ ...x, order: shuffle(x.choices), picked: null })) };
    openCard();
    render();
  }
  function close() {
    if (!active()) return;
    const wasLoading = !!loading;
    home = false; round = null; loading = null; failed = null;
    picked = null; draft = ''; // next time, start from what's in view again
    closeParts(false);
    card.hidden = true;
    if (wasLoading) SC.cancelAgent();
    if (SC.state.container === 'root') SC.select(null);
  }
  function fail(title, html, req, retry = true) {
    home = false; loading = null; round = null;
    failed = { title, html, req, retry };
    openCard();
    render();
  }

  const cut = (s, max) => (s.length > max ? s.slice(0, max).replace(/\n[^\n]*$/, '') + '\n…' : s);
  /** The request for new questions: on a topic the person typed, about one card, about recent work, or at a
   *  level. The server keeps the first 4000 characters, so what matters most comes first and the long lists are cut. */
  function promptFor({ level, focus, recent: aboutRecent, asked }) {
    const name = focus ? SC.info(focus)?.name || focus : '';
    const lines = [];
    if (focus) lines.push(`Write 3-5 questions about ${name} (${focus}): what it is for, what it uses and what uses it.${level === 'big' ? ' Keep to how it fits with the rest of the app.' : level === 'detail' ? ' Ask about the files, endpoints and smaller parts inside it.' : ''}`);
    else if (aboutRecent) lines.push('Write 3-5 questions that check the person can explain the recent work below: what changed, why it was needed, and what else it affects. Use the changed cards, or the cards they connect to, as ids.');
    else if (asked) lines.push(`Write 4-6 questions about ${PROJECT} on the topic the person typed, using whichever map items it involves.`);
    else lines.push(`Write 4-6 new questions about ${PROJECT}, covering parts of the app the questions below leave out.${LEVEL_ASK[level] ? ' ' + LEVEL_ASK[level] : ''}`);
    if (asked) lines.push(`In their own words (follow what they ask for: a topic, how many, how hard): "${asked.slice(0, 300)}"`);
    if (SC.technical()) lines.push('This person has the map\'s developer detail on, so technical terms and file names are fine.');
    if (aboutRecent) lines.push(cut(`Recent work:\n${recent.tasks.map((t, i) => {
      const its = recent.items.filter((it) => it.task === i);
      return `- ${t.title}${t.request ? ` (asked for: ${t.request})` : ''}: ${t.summary || ''}\n${its.map((it) => `  - ${it.id} (${SC.info(it.id)?.name || it.id}), ${it.change === 'new' ? 'new' : 'changed'}: ${it.note || ''}`).join('\n')}`;
    }).join('\n')}`, 1800));
    // the most recent questions are enough to steer clear of repeats
    const have = pool.slice(-30).reverse().map((x) => `- ${x.q}`).join('\n');
    if (have) lines.push(cut(`Questions the person already has:\n${have}`, 1200));
    return lines.join('\n\n');
  }
  /** Has the agent write new questions, then asks them. req: { level } or { focus: id } or { recent: true }. */
  async function more(req = { level: prefs.level }) {
    if (loading) return; // one request at a time: the card offers Stop meanwhile
    if (!canAsk()) return fail('New questions need the Ask bar', WHY[window.FLOORPLAN_SERVER ? 'cli_missing' : 'no_engine'], req, false);
    if (req.recent && !recent) return;
    const name = req.focus ? SC.info(req.focus)?.name || req.focus : '';
    const topic = req.asked && !req.focus && !req.recent ? `“${req.asked.length > 60 ? req.asked.slice(0, 57) + '…' : req.asked}”` : '';
    const title = req.focus ? name : req.recent ? 'Recent work' : topic ? 'Your topic' : req.level && req.level !== 'all' ? levelName(req.level) : 'New questions';
    home = false; round = null; failed = null;
    const mine = loading = { label: `Writing questions about ${req.focus ? name : req.recent ? 'recent work' : topic || (req.level && req.level !== 'all' ? `the ${levelName(req.level).toLowerCase()}` : PROJECT)}`, lines: ['Thinking…'] };
    openCard();
    render();
    try {
      const raw = await SC.requestAgent('quiz', promptFor(req), (t) => { if (loading === mine) { mine.lines.push(t); render(); } });
      if (loading !== mine) return; // closed meanwhile
      const added = add(Array.isArray(raw?.questions) ? raw.questions : []);
      if (!added.length) throw { code: 'quiz_empty' };
      SC.refreshPanel(); // a selected card's question count
      start(added, { kind: req.focus ? 'focus' : req.recent ? 'recent' : 'new', title, req });
    } catch (e) {
      if (loading !== mine) return;
      if (e?.name === 'AbortError') { loading = null; close(); return; }
      fail('Couldn’t write new questions', failure(e), req);
    }
  }

  SC.addHeaderButton({ id: 'quiz-btn', label: 'Quiz', svg: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.5-2.8 4.3"/><path d="M12 17.6h.01"/>', title: 'Check what you know about this app', onClick: () => (active() ? close() : openHome()) });

  // asking for a quiz in the Ask bar ("quiz me", "give me quiz questions about payments", "test me on
  // recent changes") opens it here instead of answering in words
  // only a request addressed to the person asking ("quiz me", "give me a quiz", "test me"): about an app
  // with quizzes or tests of its own, "how does a teacher create a quiz?" is a question to answer
  const WANTS_QUIZ = /^\s*quiz( me| us)?\s*[.!?]*\s*$|\bquiz (me|us)\b|\btest (me|us)\b|\b(give|make|write|generate|create)( me| us)( a| an| some| more)? (quiz|quizzes|quiz questions|practice questions)\b|\bgive me (a |some |more )?quiz\b/i;
  SC.onAsk?.((text, pinned) => {
    if (!WANTS_QUIZ.test(text)) return false;
    if (!canAsk()) { openHome(); return true; }
    const focus = pinned[0];
    more(focus ? { focus, asked: text } : recent && /\brecent|\bchange|\bjust (did|made|built)/i.test(text) ? { recent: true, asked: text } : { asked: text });
    return true;
  });

  // a card's right-click menu, and its details: the questions already about it, and new ones from the agent
  SC.addMenuItem?.((id) => (canAsk() && SC.exists(id) ? { label: 'Quiz me on this', icon: 'spark', run: () => more({ focus: id }) } : null));
  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string' || !SC.exists(id)) return '';
    const mine = about(id), ask = canAsk();
    if (!mine.length && !ask) return '';
    const name = SC.info(id)?.name || id;
    return {
      html: `<div class="sec"><h3>Quiz</h3><p class="pd">Check you know what ${h(name)} is for and how it fits in.</p>
        <div class="actions">${mine.length ? `<button class="btn soft" data-quiz-has>${SC.plural(mine.length, 'question')}</button>` : ''}${ask ? `<button class="btn soft" data-quiz-me>${SC.iconI('spark')}Quiz me on this</button>` : ''}</div></div>`,
      bind: (el) => {
        el.querySelector('[data-quiz-has]')?.addEventListener('click', (ev) => { ev.stopPropagation(); start(about(id), { kind: 'focus', title: name, req: { focus: id } }); });
        el.querySelector('[data-quiz-me]')?.addEventListener('click', (ev) => { ev.stopPropagation(); more({ focus: id }); });
      },
    };
  });

  // a menu the map has open (right-click, Flows, Filters) gets Esc first
  const menuOpen = () => document.getElementById('ctxmenu')?.hidden === false || !!document.querySelector('#flowmenu.open, #legend.open, #quiz-parts.open');
  window.addEventListener('keydown', (ev) => {
    if (!active() || ['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target?.tagName) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const stop = () => { ev.stopPropagation(); ev.preventDefault(); };
    if (ev.key === 'Escape') { if (partsOpen()) { stop(); closeParts(); return; } if (menuOpen()) return; stop(); close(); return; }
    // Enter on a focused button or link is that control's own click, not "start" or "next"
    if (ev.key === 'Enter' && ev.target?.closest?.('button, a, [role="button"], [contenteditable="true"]')) return;
    if (home && ev.key === 'Enter' && chosen(prefs.level, scope()).length) { stop(); startChosen(); return; }
    if (!round || round.done) return;
    const x = round.list[round.at];
    if (x.picked == null && /^[1-4]$/.test(ev.key) && x.order[+ev.key - 1]) { stop(); pick(+ev.key - 1); }
    else if (x.picked != null && (ev.key === 'Enter' || ev.key === 'ArrowRight')) { stop(); next(); }
  }, true);
  // a guided flow or the tour takes over the canvas: step aside. On the start screen, moving around the
  // map or selecting a card changes what the quiz is about.
  // (not while the part list is open: it would snap shut under the person browsing it)
  SC.on('render', () => { if (active() && (SC.state.flow || window.FloorplanTour?.active())) close(); else if (active() && home && !partsOpen()) render(); });
  SC.on('panel', () => { if (active() && home && !partsOpen()) render(); });

  window.FloorplanQuiz = { open: openHome, start: startChosen, more, close, active, questions: pool, levelOf };
})();
