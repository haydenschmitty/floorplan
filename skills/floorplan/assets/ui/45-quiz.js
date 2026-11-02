// Quiz: multiple-choice questions that check the map was understood, one at a time, with the card that
// shows each answer highlighted after answering. Starter questions come from graph.quiz (written by Claude
// in architecture.json). With the Ask bar connected, More questions and "Quiz me on this" have the agent
// write new ones (the quiz mode in graph-query.js), kept until the page is closed. Talks to the viewer
// only through window.Floorplan.
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
    if (!q || choices.length < 2 || !choices.includes(answer) || !SC.exists(ref)) return null;
    return { q, choices, answer, ref, explain: norm(x.explain) };
  }
  const key = (x) => x.q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

  const style = document.createElement('style');
  style.textContent = `
#quiz { position: fixed; left: 16px; bottom: 76px; width: min(380px, calc(100vw - 32px)); max-height: calc(100vh - 160px); overflow: auto; padding: 16px 16px 12px 20px; border-radius: var(--r-panel); z-index: 6; animation: quizIn .4s var(--ease); }
#quiz[hidden] { display: none; }
#quiz .qk { font-size: 12px; color: var(--text-3); margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
#quiz .qk i { width: 3px; height: 3px; border-radius: 50%; background: var(--text-4); }
#quiz .qt { font-size: 16px; font-weight: 600; letter-spacing: -.01em; line-height: 1.35; padding-right: 22px; }
#quiz .qn { color: var(--text-2); line-height: 1.55; margin-top: 6px; font-size: 13.5px; }
#quiz .qc { display: flex; flex-direction: column; gap: 6px; margin-top: 12px; }
#quiz .qc button { display: flex; gap: 10px; align-items: baseline; width: 100%; min-height: 40px; padding: 9px 12px; border: 0; border-radius: 12px; background: rgba(var(--ink), .05); color: var(--text); font: inherit; font-size: 13.5px; line-height: 1.45; text-align: left; cursor: pointer; transition: background .2s var(--ease); }
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
#quiz .qf { display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
#quiz .dots { display: flex; gap: 4px; flex: 1; }
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
  document.body.appendChild(card);
  // what the card shows: a round of questions, the agent writing more, or why it couldn't
  let round = null, loading = null, failed = null;
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

  /** The card that shows an answer: highlighted where it sits, like a tour stop. */
  function show(ref) {
    const parent = SC.parentOf(ref) || 'root';
    if (parent === 'root') SC.go('root', { select: ref });
    else SC.reveal(ref);
  }
  const score = () => round.list.filter((x) => x.picked === x.answer).length;
  const dots = () => `<div class="dots">${round.list.map((x) => `<i class="${x.picked == null ? '' : x.picked === x.answer ? 'ok' : 'no'}"></i>`).join('')}</div>`;
  const closeBtn = `<button class="btn icon qx" data-x title="Close (Esc)">${SC.iconI('x')}</button>`;
  const moreBtn = (primary) => canAsk() ? `<button class="btn ${primary ? 'primary' : 'soft'}" data-more>${SC.iconI('spark')}More questions</button>` : '';

  function render() {
    if (loading) {
      card.innerHTML = `${closeBtn}<div class="qk"><span>Quiz</span></div><div class="qt">${h(loading.label)}</div>
        <div class="qp"><span class="spin"></span><span>${h(loading.lines[loading.lines.length - 1])}</span></div>
        <div class="qf"><span style="flex:1"></span><button class="btn" data-x>Stop</button></div>`;
    } else if (failed) {
      card.innerHTML = `${closeBtn}<div class="qk"><span>Quiz</span></div><div class="qt">${h(failed.title)}</div><div class="qn">${failed.html}</div>
        <div class="qf"><span style="flex:1"></span>${failed.retry && canAsk() ? `<button class="btn soft" data-retry>Try again</button>` : ''}<button class="btn primary" data-x>Close</button></div>`;
    } else if (round.done) {
      const n = round.list.length, s = score(), missed = round.list.filter((x) => x.picked !== x.answer);
      const note = s === n ? 'Every one right. You know how this app fits together.' : s >= n / 2 ? 'Most of the way there. The ones you missed are worth another look on the map.' : 'A good start. Try the tour again, then the ones you missed.';
      // at most two buttons: the close button already ends the quiz
      const again = missed.length ? `<button class="btn primary" data-again>Retry ${missed.length === 1 ? 'the one' : `the ${missed.length}`} you missed</button>` : '';
      const more = moreBtn(!missed.length);
      card.innerHTML = `${closeBtn}<div class="qk"><span>Quiz</span>${round.title !== 'Quiz' ? `<i></i><span>${h(round.title)}</span>` : ''}</div>
        <div class="qt">You got ${s} of ${n} right</div><div class="qn">${note}</div>
        <div class="qf">${dots()}</div>
        <div class="qf" style="justify-content:flex-end">${again}${more}${again && more ? '' : `<button class="btn${again || more ? '' : ' primary'}" data-x>Done</button>`}</div>`;
    } else {
      const x = round.list[round.at], last = round.at === round.list.length - 1, answered = x.picked != null;
      card.innerHTML = `${closeBtn}<div class="qk"><span>Quiz</span><i></i><span>${round.at + 1} of ${round.list.length}</span>${round.title !== 'Quiz' ? `<i></i><span>${h(round.title)}</span>` : ''}</div>
        <div class="qt">${h(x.q)}</div>
        <div class="qc">${x.order.map((c, k) => {
          const cls = !answered ? '' : c === x.answer ? 'right' : c === x.picked ? 'wrong' : 'dim';
          return `<button data-pick="${k}" class="${cls}" ${answered ? 'disabled' : ''}><span class="n">${k + 1}</span><span>${h(c)}</span></button>`;
        }).join('')}</div>
        ${answered ? `<div class="qe"><b>${x.picked === x.answer ? 'Right.' : `Not quite: it’s ${h(x.answer)}.`}</b>${x.explain ? ` ${h(x.explain)}` : ''}<span class="on-map">Highlighted on the map: ${h(SC.info(x.ref)?.name || x.ref)}</span></div>` : ''}
        <div class="qf">${dots()}${answered ? `<button class="btn primary" data-next>${last ? 'See your score' : 'Next'}</button>` : `<button class="btn" data-skip>Skip</button>`}</div>`;
    }
    card.querySelectorAll('[data-x]').forEach((b) => b.onclick = close);
    card.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => pick(+b.dataset.pick));
    card.querySelector('[data-next]')?.addEventListener('click', next);
    card.querySelector('[data-skip]')?.addEventListener('click', next);
    card.querySelector('[data-more]')?.addEventListener('click', () => more());
    card.querySelector('[data-retry]')?.addEventListener('click', () => more(failed.focus));
    card.querySelector('[data-again]')?.addEventListener('click', () => start(round.list.filter((x) => x.picked !== x.answer), round.title));
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
    render();
    show(x.ref);
  }
  function next() {
    if (!round || round.done) return;
    if (round.at < round.list.length - 1) { round.at++; render(); }
    else { round.done = true; render(); }
  }
  function start(list, title = 'Quiz') {
    if (!list.length) return;
    window.FloorplanTour?.end();
    SC.stopFlow();
    loading = null; failed = null;
    round = { title, at: 0, done: false, list: list.map((x) => ({ ...x, order: shuffle(x.choices), picked: null })) };
    card.hidden = false;
    render();
  }
  function close() {
    if (!active()) return;
    const wasLoading = !!loading;
    round = null; loading = null; failed = null;
    card.hidden = true;
    if (wasLoading) SC.cancelAgent();
    if (SC.state.container === 'root') SC.select(null);
  }
  function fail(title, html, focus, retry = true) {
    loading = null; round = null;
    failed = { title, html, focus, retry };
    card.hidden = false;
    render();
  }

  /** Has the agent write new questions, about the whole map or one card, then asks them. */
  async function more(focus) {
    if (!canAsk()) return fail('New questions need the Ask bar', WHY[window.FLOORPLAN_SERVER ? 'cli_missing' : 'no_engine'], focus, false);
    const name = focus ? SC.info(focus)?.name || focus : '';
    window.FloorplanTour?.end();
    round = null; failed = null;
    loading = { label: focus ? `Writing questions about ${name}` : 'Writing new questions', lines: ['Thinking…'] };
    card.hidden = false;
    render();
    const prompt = [
      focus ? `Write 3-5 questions about ${name} (${focus}): what it is for, what it uses and what uses it.` : `Write 4-6 new questions about ${G.project.name}, covering parts of the app the questions below leave out.`,
      SC.technical() ? 'This person has the map\'s developer detail on, so technical terms and file names are fine.' : '',
      pool.length ? `Questions the person already has:\n${pool.map((x) => `- ${x.q}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
    try {
      const raw = await SC.requestAgent('quiz', prompt, (t) => { if (loading) { loading.lines.push(t); render(); } });
      if (!loading) return; // closed meanwhile
      const added = add(Array.isArray(raw?.questions) ? raw.questions : []);
      if (!added.length) throw { code: 'quiz_empty' };
      start(added, focus ? name : 'New questions');
    } catch (e) {
      if (!loading) return;
      if (e?.name === 'AbortError') { loading = null; close(); return; }
      fail('Couldn’t write new questions', failure(e), focus);
    }
  }
  function begin() {
    if (pool.length) return start(pool);
    if (canAsk()) return more();
    fail('No questions yet', `This map has no quiz questions yet. Ask ${h(A.name)} to update the floorplan with a quiz.${SC.exported ? '' : ` ${window.FLOORPLAN_SERVER ? WHY.cli_missing : WHY.no_engine}`}`, null, false);
  }

  SC.addHeaderButton({ id: 'quiz-btn', label: 'Quiz', svg: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2a2.9 2.9 0 0 1 5.6 1c0 1.9-2.8 2.5-2.8 4.3"/><path d="M12 17.6h.01"/>', title: 'Check what you know about this app', onClick: () => (active() ? close() : begin()) });

  // a selected card: the questions already about it, and new ones from the agent
  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string' || !SC.exists(id)) return '';
    const mine = about(id), ask = canAsk();
    if (!mine.length && !ask) return '';
    const name = SC.info(id)?.name || id;
    return {
      html: `<div class="sec"><h3>Quiz</h3><p class="pd">Check you know what ${h(name)} is for and how it fits in.</p>
        <div class="actions">${mine.length ? `<button class="btn soft" data-quiz-has>${SC.plural(mine.length, 'question')}</button>` : ''}${ask ? `<button class="btn soft" data-quiz-me>${SC.iconI('spark')}Quiz me on this</button>` : ''}</div></div>`,
      bind: (el) => {
        el.querySelector('[data-quiz-has]')?.addEventListener('click', (ev) => { ev.stopPropagation(); start(about(id), name); });
        el.querySelector('[data-quiz-me]')?.addEventListener('click', (ev) => { ev.stopPropagation(); more(id); });
      },
    };
  });

  window.addEventListener('keydown', (ev) => {
    if (!active() || ev.target?.tagName === 'INPUT' || ev.target?.tagName === 'TEXTAREA' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const stop = () => { ev.stopPropagation(); ev.preventDefault(); };
    if (ev.key === 'Escape') { stop(); close(); return; }
    if (!round || round.done) return;
    const x = round.list[round.at];
    if (x.picked == null && /^[1-4]$/.test(ev.key) && x.order[+ev.key - 1]) { stop(); pick(+ev.key - 1); }
    else if (x.picked != null && (ev.key === 'Enter' || ev.key === 'ArrowRight')) { stop(); next(); }
  }, true);
  // a guided flow or the tour takes over the canvas: step aside
  SC.on('render', () => { if (active() && (SC.state.flow || window.FloorplanTour?.active())) close(); });

  window.FloorplanQuiz = { start: begin, more, close, active, questions: pool };
})();
