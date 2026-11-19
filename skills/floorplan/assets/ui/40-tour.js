// "Start here": a calm one-minute tour on first open. What the app is, its main parts, the outside
// services it leans on, then one real path traced end to end. Steps come from graph.tour (written by
// Claude in architecture.json) or are built from the map itself.
(() => {
  const SC = window.Floorplan;
  if (!SC) return;
  const G = SC.graph;
  const { h } = SC;
  const SEEN = 'tour-seen:' + (G.project?.name || G.meta?.rootName || 'map');

  const style = document.createElement('style');
  style.textContent = `
#tour { position: fixed; left: 16px; bottom: 76px; width: min(360px, calc(100vw - 32px)); padding: 16px 16px 12px 20px; border-radius: var(--r-panel); z-index: 6; animation: tourIn .4s var(--ease); }
#tour[hidden] { display: none; }
#tour .tk { font-size: 12px; color: var(--text-3); margin-bottom: 4px; display: flex; gap: 6px; align-items: center; }
#tour .tk i { width: 3px; height: 3px; border-radius: 50%; background: var(--text-4); }
#tour .tt { font-size: 16px; font-weight: 600; letter-spacing: -.01em; line-height: 1.35; padding-right: 22px; }
#tour .tn { color: var(--text-2); line-height: 1.55; margin-top: 6px; font-size: 13.5px; }
#tour .tip { color: var(--text-3); font-size: 12px; line-height: 1.5; margin-top: 10px; }
#tour .tf { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
#tour .dots { display: flex; gap: 4px; flex: 1; }
#tour .dots i { width: 14px; height: 3px; border-radius: 2px; background: rgba(var(--ink), .12); transition: background .3s var(--ease); }
#tour .dots i.on { background: var(--on); }
#tour .tf .btn { height: 32px; }
#tour .tf .btn.icon { width: 32px; }
#tour .tx { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; }
@keyframes tourIn { from { opacity: 0; transform: translateY(8px) scale(.98); } }
`;
  document.head.appendChild(style);

  // ---------- steps ----------
  const clip = (s, max = 230) => {
    s = String(s || '').trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
    return end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
  };
  const listOf = (names) => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const tops = G.nodes.filter((n) => !n.parent && n.id !== 'unassigned');
  const bySize = (a, b) => (b.stats?.files || 0) - (a.stats?.files || 0);
  const screensOf = (id) => (G.screens || []).filter((s) => s.app === id).length;

  function flowStep() {
    const f = (G.flows || []).find((x) => !x.custom) || (G.flows || [])[0];
    if (!f || !f.steps?.length) return null;
    return { ref: 'root', flow: f.id, kicker: 'One real path', title: f.title, note: `${f.description ? clip(f.description, 160) + ' ' : ''}Press Play to follow it through the code, one step at a time.` };
  }
  function autoSteps() {
    const p = G.project || {};
    const steps = [{ ref: 'root', kicker: 'The codebase', title: p.name || 'This codebase', note: clip(p.summary) || 'A map of the main parts of this app and how they talk to each other.' }];
    const ui = tops.filter((n) => n.kind === 'ui').sort(bySize).slice(0, 2);
    for (const n of ui) {
      const k = screensOf(n.id);
      steps.push({ ref: 'n:' + n.id, kicker: 'What people use', title: n.label, note: clip(n.summary, 200) + (k > 1 ? ` It has ${k} screens.` : '') });
    }
    let back = tops.filter((n) => n.kind === 'service' || n.kind === 'worker').sort(bySize);
    if (!back.length) back = tops.filter((n) => !['ui', 'external', 'test', 'script', 'config', 'infra', 'misc'].includes(n.kind)).sort(bySize);
    for (const n of back.slice(0, ui.length > 1 ? 1 : 2)) steps.push({ ref: 'n:' + n.id, kicker: 'Behind the scenes', title: n.label, note: clip(n.summary, 200) });
    const data = tops.find((n) => n.kind === 'data' && !back.includes(n));
    if (data && steps.length < 5) steps.push({ ref: 'n:' + data.id, kicker: 'Where the data lives', title: data.label, note: clip(data.summary, 200) });
    const ext = tops.filter((n) => n.kind === 'external');
    if (ext.length) {
      steps.push({
        ref: ext.length === 1 ? 'n:' + ext[0].id : 'root', kicker: 'Outside services', title: ext.length === 1 ? ext[0].label : `${ext.length} outside services`,
        note: ext.length === 1 ? clip(ext[0].summary, 200) : `It also relies on ${listOf(ext.slice(0, 6).map((n) => n.label))}${ext.length > 6 ? ` and ${ext.length - 6} more` : ''}. They sit at the edge of the map; the lines show which parts talk to them.`,
      });
    }
    return steps;
  }
  function buildSteps() {
    const own = (G.tour || []).filter((s) => s && s.ref && (s.ref === 'root' || SC.exists(s.ref))).map((s) => ({ ref: s.ref, title: s.title || SC.info(s.ref).name, note: s.note || SC.info(s.ref).desc || '', kicker: '' }));
    const steps = own.length >= 2 ? own : autoSteps();
    const fl = flowStep();
    if (fl && !steps.some((s) => s.flow) && steps.length < 9) steps.push(fl);
    return steps.filter((s) => s.ref === 'root' || SC.exists(s.ref)).slice(0, 9);
  }

  // ---------- card ----------
  const card = document.createElement('div');
  card.id = 'tour';
  card.className = 'glass';
  card.hidden = true;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Start here tour');
  document.body.appendChild(card);
  let steps = [], at = -1;
  const active = () => at >= 0;

  function go(s) {
    if (!s.ref || s.ref === 'root') { SC.go('root', { select: null }); return; }
    const parent = SC.parentOf(s.ref) || 'root';
    if (parent === 'root') SC.go('root', { select: s.ref }); // stay on the overview, just highlight the card
    else SC.reveal(s.ref);
  }
  function render() {
    const s = steps[at], last = at === steps.length - 1;
    const tip = last ? `Replay this tour any time from <b>Start here</b> at the top.${window.FloorplanScreens ? ' <b>Screens</b> shows everything behind any page.' : ''}` : '';
    card.innerHTML = `<button class="btn icon tx" data-x title="Close (Esc)">${SC.iconI('x')}</button>
      <div class="tk"><span>Start here</span><i></i><span>${at + 1} of ${steps.length}</span>${s.kicker ? `<i></i><span>${h(s.kicker)}</span>` : ''}</div>
      <div class="tt">${h(s.title)}</div>${s.note ? `<div class="tn">${h(s.note)}</div>` : ''}${tip ? `<div class="tip">${tip}</div>` : ''}
      <div class="tf"><div class="dots">${steps.map((_, k) => `<i class="${k <= at ? 'on' : ''}"></i>`).join('')}</div>
        ${at > 0 ? `<button class="btn icon soft" data-back title="Back (←)">${SC.iconI('left')}</button>` : `<button class="btn" data-x>Skip</button>`}
        ${s.flow ? `<button class="btn primary" data-play>${SC.iconI('right')}Play it</button>${last ? '' : '<button class="btn soft" data-next>Next</button>'}` : `<button class="btn primary" data-next>${last ? 'Done' : 'Next'}</button>`}
      </div>`;
    card.querySelectorAll('[data-x]').forEach((b) => b.onclick = end);
    card.querySelector('[data-back]')?.addEventListener('click', back);
    card.querySelector('[data-next]')?.addEventListener('click', next);
    card.querySelector('[data-play]')?.addEventListener('click', () => { const id = s.flow; end(); SC.startFlow(id); });
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
  function show(i) {
    at = i;
    card.hidden = false;
    render();
    place();
    go(steps[at]);
    if (at === 0) setTimeout(() => SC.fit(true), 450);
  }
  function next() { if (at >= steps.length - 1) end(); else show(at + 1); }
  function back() { if (at > 0) show(at - 1); }
  function end() {
    if (!active()) return;
    at = -1;
    card.hidden = true;
    SC.store.set(SEEN, true);
    if (SC.state.container === 'root') SC.select(null);
  }
  function start() {
    steps = buildSteps();
    if (steps.length < 2) { SC.toast('There is not enough on this map for a tour yet.'); return; }
    SC.store.set(SEEN, true);
    show(0);
  }

  const tourBtn = SC.addHeaderButton({ id: 'tour-btn', label: 'Start here', icon: 'home', title: 'A one-minute tour of this codebase', onClick: () => (active() ? end() : start()) });
  const ic = tourBtn.querySelector('svg');
  if (ic) ic.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8z"/>'; // compass
  window.addEventListener('keydown', (ev) => {
    if (!active() || ev.target?.tagName === 'INPUT' || ev.target?.tagName === 'TEXTAREA') return;
    if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); end(); }
    else if (!SC.state.flow && ev.key === 'ArrowRight') { ev.stopPropagation(); ev.preventDefault(); next(); }
    else if (!SC.state.flow && ev.key === 'ArrowLeft') { ev.stopPropagation(); ev.preventDefault(); back(); }
  }, true);
  // a guided flow takes over the canvas: step aside
  SC.on('render', () => { if (active() && SC.state.flow) end(); });

  // First visit: start on its own, unless the link points somewhere specific (any #… address, including the
  // #tour=0 a page embedding the map can add to say "not on its own"). Where the browser won't keep anything
  // between visits (a sandboxed frame, strict settings), it can't tell a first visit from the hundredth, so it
  // never starts on its own there: Start here is always one press away.
  let auto = false;
  const maybeAuto = () => {
    if (auto) return;
    auto = true;
    if (SC.store.persistent === false || SC.store.get(SEEN, false) || location.hash.length > 1) return;
    setTimeout(() => { if (!active() && !SC.state.flow && SC.state.container === 'root') start(); }, 700);
  };
  SC.on('ready', maybeAuto);
  if (SC.state.layout) maybeAuto();

  window.FloorplanTour = { start, end, active };
})();
