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
  /** "Which part shows the lockers?" → "Lockers": the answer is right there in the question. */
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
    { id: 'detail', label: 'In detail', hint: 'Files, endpoints and the parts inside' },
    { id: 'all', label: 'Both', hint: 'Main parts and details, mixed' },
  ];
  // inside a chosen part, its big picture is the part itself and what sits directly in it
  const levelOf = (x, part = '') => (x.ref === part || (SC.parentOf(x.ref) || 'root') === (part || 'root') ? 'big' : 'detail');
  const atLevel = (level, part = '') => pool.filter((x) => level === 'all' || levelOf(x, part) === level);
  const LEVEL_ASK = {
    big: 'Ask about the main parts of the app (the top-level cards and outside services) and how they connect: what each is for, which talks to which, and what happens end to end. Use their ids.',
    detail: 'Ask about specific files and endpoints (f:... and r:... ids) and the smaller parts inside the main ones: what each does, what uses it, and what happens step by step.',
    all: '',
  };
  // the part of the app to be asked about: a main part or one inside it, or the whole app ('')
  const PARTS = G.nodes.filter((n) => !n.parent && n.id !== 'unassigned').flatMap((n) => [
    { id: 'n:' + n.id, name: n.label, sub: false },
    ...G.nodes.filter((c) => c.parent === n.id).map((c) => ({ id: 'n:' + c.id, name: c.label, sub: true })),
  ]).filter((p) => SC.exists(p.id));
  const inPart = (x, part) => !part || x.ref === part || SC.chain(x.ref).includes(part);
  const chosen = (level, part) => atLevel(level, part).filter((x) => inPart(x, part));
  const COUNTS = [5, 10, 20];
  const PROJECT = G.project?.name || G.meta?.rootName || 'map';
  const prefs = {
    get level() { const l = SC.store.get('quiz-level:' + PROJECT, 'all'); return LEVELS.some((x) => x.id === l) ? l : 'all'; },
    set level(l) { SC.store.set('quiz-level:' + PROJECT, l); },
    get part() { const p = SC.store.get('quiz-part:' + PROJECT, ''); return PARTS.some((x) => x.id === p) ? p : ''; },
    set part(p) { SC.store.set('quiz-part:' + PROJECT, p); },
    // questions in one round: long enough to mean something, short enough to finish
    get count() { const c = +SC.store.get('quiz-count:' + PROJECT, 10); return COUNTS.includes(c) ? c : 10; },
    set count(c) { SC.store.set('quiz-count:' + PROJECT, +c); },
    best: () => SC.store.get('quiz-best:' + PROJECT, {}) || {},
    /** Keeps the better of this score and the one saved for the level. */
    score(level, s, n) {
      const all = prefs.best(), was = all[level];
      if (was && was.s / was.n >= s / n) return false;
      SC.store.set('quiz-best:' + PROJECT, { ...all, [level]: { s, n } });
      return true;
    },
    // the questions answered right at least once, so a round asks the others first
    right: () => new Set(SC.store.get('quiz-right:' + PROJECT, []) || []),
    gotRight(x) { const r = prefs.right(); if (r.has(key(x))) return; r.add(key(x)); SC.store.set('quiz-right:' + PROJECT, [...r].slice(-500)); },
  };
  /** Up to a round's worth: the ones not answered right yet first, each group in a new order. */
  const roundOf = (list) => {
    const r = prefs.right();
    return [...shuffle(list.filter((x) => !r.has(key(x)))), ...shuffle(list.filter((x) => r.has(key(x))))].slice(0, prefs.count);
  };
  const partName = (id) => PARTS.find((p) => p.id === id)?.name || SC.info(id)?.name || id;
  // the best score is kept per level and part
  const bestKey = (level, part) => (part ? `${level}:${part}` : level);

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
#quiz .ql button .c { display: block; font-size: 11px; color: var(--text-3); font-variant-numeric: tabular-nums; }
#quiz .ql button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-card); font-weight: 600; }
#quiz .qrow { display: flex; gap: 8px; margin-top: 12px; }
#quiz .qsel { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--text-3); }
#quiz .qsel.n { flex: 0 0 auto; }
#quiz select, #quiz .qa input { min-height: 44px; padding: 0 10px; border: 0; border-radius: 10px; background: rgba(var(--ink), .05); color: var(--text); font: inherit; font-size: 13px; min-width: 0; }
#quiz select option { background: var(--surface); color: var(--text); }
#quiz .qa { display: flex; gap: 6px; margin-top: 10px; }
#quiz .qa input { flex: 1; padding: 0 12px; }
#quiz .qa input::placeholder { color: var(--text-3); }
#quiz .qa .btn { height: 44px; }
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
  const bestText = (level, part) => { const b = prefs.best()[bestKey(level, part)]; return b ? `${b.s} of ${b.n}` : ''; };
  /** A round at the chosen level and part, with the title saying which. */
  const startChosen = () => {
    const { level, part } = prefs;
    start(chosen(level, part), { kind: 'level', level, part, title: [part && partName(part), level !== 'all' && levelName(level)].filter(Boolean).join(' · ') });
  };

  function renderHome() {
    const { level, part, count } = prefs, list = chosen(level, part), best = bestText(level, part);
    const ask = canAsk(), right = prefs.right(), done = list.filter((x) => right.has(key(x))).length;
    const progress = done ? ` You’ve got <b>${done} of ${list.length}</b> right${best ? `, best round <b>${best}</b>` : ''}.` : best ? ` Your best: <b>${best}</b>.` : '';
    const where = part ? partName(part) : 'the app';
    card.innerHTML = `${closeBtn}${kicker()}
      <div class="qt">How well do you know ${h(part ? partName(part) : PROJECT)}?</div>
      <div class="qn">After each question, the card that shows the answer lights up on the map.</div>
      <div class="qrow">
        <label class="qsel">Part of the app<select data-part>${[{ id: '', name: 'The whole app' }, ...PARTS.filter((p) => ask || p.id === part || chosen('all', p.id).length)].map((p) => `<option value="${h(p.id)}" ${p.id === part ? 'selected' : ''}>${p.sub ? '   ' : ''}${h(p.name)}${p.id ? ` (${chosen('all', p.id).length})` : ''}</option>`).join('')}</select></label>
        <label class="qsel n">Per round<select data-count>${COUNTS.map((c) => `<option value="${c}" ${c === count ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      </div>
      <div class="ql" role="radiogroup" aria-label="How deep">${LEVELS.map((l) => `<button role="radio" aria-checked="${l.id === level}" class="${l.id === level ? 'on' : ''}" data-level="${l.id}" title="${h(l.hint)}">${h(l.label)}<span class="c">${SC.plural(chosen(l.id, part).length, 'question')}</span></button>`).join('')}</div>
      <div class="qh">${h(LEVELS.find((l) => l.id === level).hint)}.${progress}${list.length > count ? ` Rounds of ${count}, the ones you haven’t got right first.` : ''}</div>
      ${ask ? `<form class="qa" data-topic><input name="t" maxlength="300" autocomplete="off" placeholder="Any topic? e.g. sign-in" aria-label="What new questions should be about (optional)"><button class="btn soft" type="submit" title="Have ${h(A.name)} write new questions for what you picked">${SC.iconI('spark')}${list.length ? 'More' : 'Write'}</button></form>` : ''}
      ${(recent && ask) || list.length ? `<div class="qf end">${recent && ask ? `<button class="btn soft" data-recent title="Questions about what was just changed, to check you can explain it">Recent work</button>` : ''}${list.length ? `<button class="btn primary" data-go>Start</button>` : ''}</div>` : ''}
      ${!list.length && !ask ? `<div class="qh">No questions about ${h(where)} at this level yet.${SC.exported ? '' : ` ${window.FLOORPLAN_SERVER ? WHY.cli_missing : WHY.no_engine}`}</div>` : ''}`;
    card.querySelectorAll('[data-level]').forEach((b) => b.onclick = () => { prefs.level = b.dataset.level; render(); });
    card.querySelector('[data-part]').onchange = (ev) => { prefs.part = ev.target.value; render(); card.querySelector('[data-part]')?.focus(); };
    card.querySelector('[data-count]').onchange = (ev) => { prefs.count = ev.target.value; render(); card.querySelector('[data-count]')?.focus(); };
    card.querySelector('[data-go]')?.addEventListener('click', startChosen);
    card.querySelector('[data-recent]')?.addEventListener('click', () => more({ recent: true }));
    // new questions for the chosen part and depth, on the typed topic if there is one
    card.querySelector('[data-topic]')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const asked = ev.target.t.value.trim();
      more({ level: prefs.level, focus: prefs.part || undefined, ...(asked ? { asked } : {}) });
    });
  }

  function render() {
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
      const note = s === n ? 'Every one right. You know how this fits together.' : s >= n / 2 ? 'Most of the way there. The ones you missed are worth another look on the map.' : 'A good start. Try the tour again, then the ones you missed.';
      const best = round.kind === 'level' && round.newBest ? ' A new best.' : '';
      // at most two buttons: the close button already ends the quiz, and the Quiz button reopens the start
      const again = missed.length ? `<button class="btn primary" data-again>Retry ${missed.length === 1 ? 'the one' : `the ${missed.length}`} you missed</button>` : '';
      const more = canAsk() ? `<button class="btn ${missed.length ? 'soft' : 'primary'}" data-more>${SC.iconI('spark')}More questions</button>` : '';
      card.innerHTML = `${closeBtn}${kicker(round.title)}
        <div class="qt">You got ${s} of ${n} right</div><div class="qn">${note}${best}</div>
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
    // a whole round at one level counts toward its best score; retries and one-card quizzes don't
    if (round.kind === 'level') round.newBest = prefs.score(bestKey(round.level, round.part), score(), round.list.length) && !!round.hadBest;
    render();
  }
  function openCard() { window.FloorplanTour?.end(); card.hidden = false; }
  function openHome() {
    home = true; round = null; loading = null; failed = null;
    openCard();
    render();
  }
  /** Asks these questions (a round's worth), with their choices shuffled. kind: level (a round at a level and part, for the best score), retry, focus, recent, new. */
  function start(list, { kind = 'new', level = '', part = '', title = '', req = null } = {}) {
    if (!list.length) return;
    SC.stopFlow();
    home = false; loading = null; failed = null;
    round = { kind, level, part, req, title, hadBest: !!prefs.best()[bestKey(level, part)], at: 0, done: false,
      list: roundOf(list).map((x) => ({ ...x, order: shuffle(x.choices), picked: null })) };
    openCard();
    render();
  }
  function close() {
    if (!active()) return;
    const wasLoading = !!loading;
    home = false; round = null; loading = null; failed = null;
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

  /** The request for new questions: at a level, about one card, or about recent work, plus the person's own words when they typed it. */
  function promptFor({ level, focus, recent: aboutRecent, asked }) {
    const name = focus ? SC.info(focus)?.name || focus : '';
    const lines = [];
    if (focus) lines.push(`Write 3-5 questions about ${name} (${focus}): what it is for, what it uses and what uses it.${level === 'big' ? ' Keep to how it fits with the rest of the app.' : level === 'detail' ? ' Ask about the files, endpoints and smaller parts inside it.' : ''}`);
    else if (aboutRecent) {
      lines.push('Write 3-5 questions that check the person can explain the recent work below: what changed, why it was needed, and what else it affects. Use the changed cards, or the cards they connect to, as ids.');
      lines.push(`Recent work:\n${recent.tasks.map((t, i) => {
        const its = recent.items.filter((it) => it.task === i);
        return `- ${t.title}${t.request ? ` (asked for: ${t.request})` : ''}: ${t.summary || ''}\n${its.map((it) => `  - ${it.id} (${SC.info(it.id)?.name || it.id}), ${it.change === 'new' ? 'new' : 'changed'}: ${it.note || ''}`).join('\n')}`;
      }).join('\n')}`);
    } else lines.push(`Write 4-6 new questions about ${PROJECT}, covering parts of the app the questions below leave out.${LEVEL_ASK[level] ? ' ' + LEVEL_ASK[level] : ''}`);
    if (asked) lines.push(`The person asked for this quiz in their own words, so follow what they asked for (a topic, how many, how hard): "${asked}"`);
    if (SC.technical()) lines.push('This person has the map\'s developer detail on, so technical terms and file names are fine.');
    // the most recent questions are enough to steer clear of repeats, and keep the request short
    const have = pool.slice(-30).map((x) => `- ${x.q}`).join('\n');
    if (have) lines.push(`Questions the person already has:\n${have}`);
    return lines.join('\n\n');
  }
  /** Has the agent write new questions, then asks them. req: { level } or { focus: id } or { recent: true }. */
  async function more(req = { level: prefs.level }) {
    if (loading) return; // one request at a time: the card offers Stop meanwhile
    if (!canAsk()) return fail('New questions need the Ask bar', WHY[window.FLOORPLAN_SERVER ? 'cli_missing' : 'no_engine'], req, false);
    if (req.recent && !recent) return;
    const name = req.focus ? SC.info(req.focus)?.name || req.focus : '';
    const title = req.asked ? 'Your questions' : req.focus ? name : req.recent ? 'Recent work' : req.level && req.level !== 'all' ? levelName(req.level) : 'New questions';
    home = false; round = null; failed = null;
    const mine = loading = { label: req.focus ? `Writing questions about ${name}` : req.recent ? 'Writing questions about recent work' : 'Writing new questions', lines: ['Thinking…'] };
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
  // only a request for a quiz: "where is the quiz scored?" about an app that has its own quiz is a question
  const WANTS_QUIZ = /^\s*quiz\b|\bquiz me\b|\b(give|make|write|generate|create|start)( me)?( a| an| some| more| the)? (quiz|practice questions|test questions)\b|\btest (me|my (knowledge|understanding))\b/i;
  SC.onAsk?.((text, pinned) => {
    if (!WANTS_QUIZ.test(text)) return false;
    if (!canAsk()) { openHome(); return true; }
    const focus = pinned[0];
    const level = /\bbig[- ]picture|\boverview|\bmain parts|\bhigh[- ]level|\beasy\b/i.test(text) ? 'big' : /\bdetail|\bfiles?\b|\bendpoints?\b|\bhard(er)?\b|\bdeep(er)?\b/i.test(text) ? 'detail' : 'all';
    more(focus ? { focus, asked: text } : recent && /\brecent|\bchange|\bjust (did|made|built)/i.test(text) ? { recent: true, asked: text } : { level, asked: text });
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

  window.addEventListener('keydown', (ev) => {
    if (!active() || ['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target?.tagName) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const stop = () => { ev.stopPropagation(); ev.preventDefault(); };
    if (ev.key === 'Escape') { stop(); close(); return; }
    if (home && ev.key === 'Enter' && chosen(prefs.level, prefs.part).length) { stop(); startChosen(); return; }
    if (!round || round.done) return;
    const x = round.list[round.at];
    if (x.picked == null && /^[1-4]$/.test(ev.key) && x.order[+ev.key - 1]) { stop(); pick(+ev.key - 1); }
    else if (x.picked != null && (ev.key === 'Enter' || ev.key === 'ArrowRight')) { stop(); next(); }
  }, true);
  // a guided flow or the tour takes over the canvas: step aside
  SC.on('render', () => { if (active() && (SC.state.flow || window.FloorplanTour?.active())) close(); });

  window.FloorplanQuiz = { open: openHome, start: startChosen, more, close, active, questions: pool, levelOf };
})();
