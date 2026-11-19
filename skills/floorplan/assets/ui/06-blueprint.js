// Blueprints: a map planned from a PRD or a description, before any code exists (graph.meta.blueprint,
// from scripts/plan.mjs). Cards get a dashed outline and the project name a "Blueprint" pill, the
// overview says what it was planned from, and every planned part offers "Build this with Claude": a
// ready prompt to build just that part, following the plan. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const BP = SC && SC.graph.meta.blueprint;
  if (!BP) return;
  const { h } = SC;
  const Cap = (t) => t[0].toUpperCase() + t.slice(1);
  const A = SC.agent || { name: 'Claude', app: 'Claude Code' };
  const G = SC.graph;

  document.documentElement.classList.add('blueprint');
  const style = document.createElement('style');
  style.textContent = `
    /* planned, not built: a dashed outline on every card */
    html.blueprint .card:not(.connector)::after { content: ""; position: absolute; inset: 0; border-radius: inherit; border: 2.5px dashed rgba(var(--ink), .32); pointer-events: none; }
    .bp-pill { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; margin-left: 8px; border-radius: 999px; font-size: 11px; font-weight: 500; letter-spacing: .02em; color: var(--text-2); border: 1px dashed rgba(var(--ink), .35); flex: none; }
    .bp-list { margin: 8px 0 0; padding-left: 18px; color: var(--text-2); font-size: 13px; line-height: 1.55; }
    .bp-list li + li { margin-top: 4px; }
  `;
  document.head.appendChild(style);

  // a "Blueprint" pill beside the board's title, which is redrawn on every move
  const addPill = () => {
    const k = document.querySelector('#context .k');
    if (!k || k.querySelector('.bp-pill')) return;
    k.insertAdjacentHTML('beforeend', '<span class="bp-pill" title="Planned, not built yet: every card is a part the system would need.">Blueprint</span>');
  };
  SC.on('render', addPill);
  SC.on('ready', addPill);

  const ACCESS = { public: 'anyone', 'signed-in': 'signed-in users', team: 'only the team that runs the service', webhook: 'the service that sends it, which must prove it', internal: 'only our own services' };
  /** "for signed-in users: managers of that location", or the open question when nobody decided. */
  const whoMay = (r) => !r.access ? 'who may use it isn’t decided yet: ask me'
    : `for ${r.access === 'signed-in' && r.who ? r.who : ACCESS[r.access] || r.access}${r.publicBecause ? `, because ${r.publicBecause.replace(/\.$/, '')}` : ''}`;

  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>Blueprint</h3>
      <p class="pd">Planned${BP.source ? ` from <b>${h(BP.source)}</b>` : ''}, not built yet. Every dashed card is a part the system would need.${SC.exported ? '' : ` Pick one and choose <b>Build this with ${h(A.name)}</b> to start on it.`}</p>
      ${BP.stack?.length ? `<div class="tags" style="margin-top:10px">${BP.stack.map((s) => `<span class="tag">${h(s)}</span>`).join('')}</div>` : ''}
      ${BP.assumptions?.length ? `<h3 style="margin-top:14px">Assumptions</h3><ul class="bp-list">${BP.assumptions.map((a) => `<li>${h(a)}</li>`).join('')}</ul>` : ''}
    </div>`,
  }));

  /** The planned files inside an item (a part, a folder or one file). */
  const filesIn = (id) => G.files.filter((f) => id === 'f:' + f.p || SC.chain('f:' + f.p).includes(id));
  function buildPrompt(id) {
    const i = SC.info(id);
    const fl = filesIn(id);
    const paths = new Set(fl.map((f) => 'f:' + f.p));
    const eps = SC.routes.filter((r) => paths.has('f:' + r.f));
    const deps = new Map();
    for (const l of G.links) {
      if (!paths.has(l.a) || paths.has(l.b)) continue;
      const o = SC.info(l.b);
      if (o) deps.set(l.b, `${o.name}${l.b.startsWith('f:') ? ` (${l.b.slice(2)})` : ''}`);
    }
    // open questions from the PRD that touch this part
    const inside = (x) => x === id || paths.has(x) || (x.startsWith('r:') && paths.has('f:' + SC.routes[+x.slice(2)]?.f)) || (SC.exists(x) && SC.chain(x).includes(id));
    const questions = (G.health?.issues || []).filter((q) => q.kind === 'question' && (q.items || []).some(inside)).map((q) => q.title);
    return [
      `Build "${i.name}" from the ${G.project.name} blueprint: floorplan/plan.json and floorplan/architecture.json${BP.source ? `, planned from ${BP.source}` : ''}.`,
      i.desc ? `\nWhat it's for: ${i.desc}` : '',
      BP.stack?.length ? `\nStack: ${BP.stack.join('; ')}.` : '',
      `\nFiles to create:`,
      ...fl.map((f) => `- ${f.p}: ${f.name}${f.d ? `. ${f.d}` : ''}`),
      eps.length ? `\nEndpoints to create (keep the method, path and who may use them exactly as planned):` : '',
      ...eps.map((r) => `- ${r.m} ${r.p} (${whoMay(r)}): ${r.name}${r.d ? `. ${r.d}` : ''}`),
      deps.size ? `\nIt relies on: ${[...deps.values()].join('; ')}.` : '',
      questions.length ? `\nStill undecided (ask me before building what depends on it):\n${questions.map((q) => `- ${q}`).join('\n')}` : '',
      `\nBefore writing code, read these parts of plan.json, and check which of the things it relies on exist yet; if some don't, tell me and suggest what to build first. Keep the plan's file paths and names. If the plan looks wrong or incomplete for this part, tell me before changing it. When it's done, run it or its tests and tell me how to try it.`,
    ].filter((x) => x !== '').join('\n');
  }

  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string') return '';
    // an endpoint: who the plan lets use it
    if (id.startsWith('r:')) {
      const r = SC.routes[+id.slice(2)];
      if (!r) return '';
      const text = !r.access ? `Not decided yet.${SC.graph.health ? ' The design review lists it.' : ''}` : `${Cap(r.access === 'signed-in' && r.who ? r.who : ACCESS[r.access] || r.access)}.${r.publicBecause ? ` Open on purpose: ${r.publicBecause}` : ''}`;
      return `<div class="sec"><h3>Who may use it</h3><p class="pd">${h(text)}</p></div>`;
    }
    const i = SC.info(id);
    if (SC.exported || !i || (i.type === 'node' && i.n.kind === 'external') || !filesIn(id).length) return '';
    return {
      html: `<div class="sec"><h3>Build it</h3><p class="pd">A ready request for ${h(A.app)} to build ${i.type === 'file' ? 'this file' : 'this part'} the way the plan describes.</p>
        <div class="actions"><button class="btn soft" data-bp-build>${SC.iconI('spark')}Build this with ${h(A.name)}</button></div></div>`,
      bind: (el) => el.querySelector('[data-bp-build]')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const prompt = buildPrompt(id);
        SC.modal({
          title: `Build this with ${A.name}`,
          html: `<p class="hc-hint">Copy this request and paste it into <b>${h(A.app)}</b>, opened in your project folder.</p><pre>${h(prompt)}</pre>`,
          actions: [{ label: 'Copy prompt', primary: true, icon: 'copy', onClick: () => { SC.copy(prompt).then((ok) => { if (ok) SC.toast(`Copied. Paste it into ${A.app}.`); }); } }],
        });
      }),
    };
  });
})();
