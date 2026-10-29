// Health check panel: plain-language warnings from graph.health (lib/health.mjs) — leaked keys,
// endpoints anyone can call, unused and oversized files — each with "Show on map" and a ready
// prompt to paste into Claude Code or Codex. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  if (!SC) return;
  const { h } = SC;
  const A = SC.agent?.fix || SC.agent || { name: 'Claude', app: 'Claude Code' };
  const issues = (SC.graph.health && SC.graph.health.issues) || [];

  const SEV = {
    high: { color: 'var(--sev-high)', group: 'Fix these first', word: 'important' },
    medium: { color: 'var(--sev-medium)', group: 'Worth fixing soon', word: 'worth fixing' },
    low: { color: 'var(--sev-low)', group: 'Good to tidy up', word: 'minor' },
  };
  const ORDER = ['high', 'medium', 'low'];
  const count = (sev) => issues.filter((i) => i.severity === sev).length;
  const urgent = count('high') + count('medium');

  SC.icons.health = '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>';
  SC.icons.check = '<path d="m5 12.5 4.5 4.5L19 7.5"/>';

  const style = document.createElement('style');
  style.textContent = `
    .hc-issue { padding: 12px 14px; border-radius: 16px; background: rgba(var(--ink), .04); margin-bottom: 8px; }
    .hc-issue:last-child { margin-bottom: 0; }
    .hc-t { display: flex; gap: 9px; align-items: flex-start; font-weight: 500; line-height: 1.4; }
    .hc-t .dot { margin-top: 6px; }
    .hc-d { color: var(--text-2); font-size: 12.5px; line-height: 1.55; margin: 6px 0 0 17px; }
    .hc-n { color: var(--text-3); font-size: 12.5px; line-height: 1.45; margin: 4px 0 0 17px; }
    .hc-w { font-family: var(--mono); font-size: 11px; color: var(--text-3); margin: 6px 0 0 17px; word-break: break-all; line-height: 1.5; }
    .hc-a { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 0 17px; }
    .hc-a .btn { height: 30px; padding: 0 12px; font-size: 12.5px; gap: 6px; }
    .hc-a .btn svg.i { width: 14px; height: 14px; }
    .hc-calm { margin-top: 14px; padding: 11px 13px; border-radius: 14px; background: var(--ok-bg); color: var(--ok-text); font-size: 13px; line-height: 1.55; }
    .hc-sub { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 12px; font-size: 12px; color: var(--text-2); }
    .hc-sub span { display: inline-flex; align-items: center; gap: 6px; }
    #btn-health .badge { background: var(--hc-badge, var(--on)); color: var(--hc-badge-text, var(--on-text)); }
    #btn-health.calm svg.i { color: var(--ok); }
    #modal .hc-hint { margin: 0; }
    #modal .hc-hint b { color: var(--text); font-weight: 500; }
  `;
  document.head.appendChild(style);

  // ---------- actions ----------
  let isOpen = false, openedAt = null;
  const where = () => JSON.stringify([SC.state.selected, SC.state.container]);
  function closeList() { isOpen = false; SC.closePanel(); }
  function showOnMap(issue) {
    const items = (issue.items || []).filter((id) => SC.exists(id)).map((id) => ({ id, note: (issue.notes && issue.notes[id]) || '' }));
    if (!items.length) { SC.toast(`This one isn’t on the map. Use “Fix with ${A.name}” instead.`); return; }
    if (isOpen) closeList();
    SC.showBoard({ title: issue.title, question: issue.detail, items });
  }
  function fixWith(issue) {
    SC.modal({
      title: `Fix with ${A.name}`,
      html: `<p class="hc-hint">Copy this request and paste it into <b>${A.app}</b>, opened in your project folder. It explains what to change and asks before anything risky.</p><pre>${h(issue.fix)}</pre>`,
      actions: [{ label: 'Copy prompt', primary: true, icon: 'copy', onClick: () => { SC.copy(issue.fix); SC.toast(`Copied. Paste it into ${A.app}.`); } }],
    });
  }
  const onMap = (issue) => (issue.items || []).some((id) => SC.exists(id));

  // ---------- html ----------
  const locText = (issue) => {
    const locs = issue.locations || [];
    if (!SC.technical() || !locs.length) return '';
    const shown = locs.slice(0, 3).map((l) => `${l.file}${l.line > 1 ? ':' + l.line : ''}`);
    return `<div class="hc-w">${shown.map(h).join('<br>')}${locs.length > 3 ? `<br>+${locs.length - 3} more` : ''}</div>`;
  };
  const issueHtml = (issue, idx, note) => `<div class="hc-issue">
      <div class="hc-t"><span class="dot" style="background:${SEV[issue.severity].color}"></span><span>${h(issue.title)}</span></div>
      ${note ? `<div class="hc-n">${h(note)}</div>` : `<div class="hc-d">${h(issue.detail)}</div>`}
      ${locText(issue)}
      <div class="hc-a">
        ${onMap(issue) ? `<button class="btn soft" data-hc-show="${idx}">${SC.iconI('search')}Show on map</button>` : ''}
        <button class="btn soft" data-hc-fix="${idx}">${SC.iconI('spark')}Fix with ${A.name}</button>
      </div>
    </div>`;
  const bindIssues = (el) => {
    el.querySelectorAll('[data-hc-show]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); showOnMap(issues[+b.dataset.hcShow]); }));
    el.querySelectorAll('[data-hc-fix]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); fixWith(issues[+b.dataset.hcFix]); }));
  };
  const headline = () => urgent ? `${SC.plural(urgent, 'thing')} need${urgent === 1 ? 's' : ''} attention` : issues.length ? 'Nothing urgent' : 'No problems found';
  const breakdown = () => `<div class="hc-sub">${ORDER.filter(count).map((s) => `<span><i class="dot" style="background:${SEV[s].color}"></i>${count(s)} ${SEV[s].word}</span>`).join('')}</div>`;

  function listHtml() {
    const top = `<div class="sec">
        <div class="ph"><span class="ico" style="--c:${urgent ? SEV[count('high') ? 'high' : 'medium'].color : 'var(--ok)'}">${SC.icon('health')}</span><span class="kindlabel">Health check</span></div>
        <h2 class="pt">${h(headline())}</h2>
        <p class="pd">We looked for passwords and keys left in the code, parts of your app anyone on the internet can use, leftover files and files too big to edit safely.</p>
        ${issues.length ? breakdown() : `<div class="hc-calm">Nothing stood out. This is a quick automatic check, not a full security review.</div>`}
        <div class="actions"><button class="btn soft" data-hc-back>${SC.iconI('left')}Back</button></div>
      </div>`;
    const groups = ORDER.map((sev) => {
      const list = issues.map((i, idx) => [i, idx]).filter(([i]) => i.severity === sev);
      return list.length ? `<div class="sec"><h3>${h(SEV[sev].group)} <span class="c">${list.length}</span></h3>${list.map(([i, idx]) => issueHtml(i, idx)).join('')}</div>` : '';
    }).join('');
    const foot = issues.length ? `<div class="sec" style="color:var(--text-3);font-size:12px;line-height:1.6">These are automatic hints. “Fix with ${A.name}” gives you a request to paste into ${A.app}; it checks the code before changing anything.</div>` : '';
    return top + groups + foot;
  }
  function openList() {
    isOpen = true;
    openedAt = where();
    SC.showPanel(listHtml(), (panel) => {
      panel.querySelector('[data-hc-back]')?.addEventListener('click', closeList);
      bindIssues(panel);
    });
  }

  // ---------- chrome ----------
  const btn = SC.addHeaderButton({
    id: 'btn-health', label: 'Health', icon: urgent ? 'health' : 'check',
    title: urgent ? `Health check: ${headline()}` : 'Health check: nothing urgent',
    onClick: () => (isOpen ? closeList() : openList()),
  });
  if (urgent) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = urgent > 99 ? '99+' : String(urgent);
    btn.style.setProperty('--hc-badge', count('high') ? SEV.high.color : SEV.medium.color);
    btn.style.setProperty('--hc-badge-text', 'var(--on-sev-text)');
    btn.appendChild(b);
  } else btn.classList.add('calm');

  // Selecting something else on the map while the list is open shows that item instead.
  SC.on('panel', () => { if (isOpen && openedAt && where() !== openedAt) { isOpen = false; SC.closePanel(); } });

  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>Health</h3><div class="list"><a class="row" data-hc-open>
        <span class="dot" style="background:${urgent ? SEV[count('high') ? 'high' : 'medium'].color : 'var(--ok)'}"></span>
        <span class="rt"><div class="rn">${h(headline())}</div><div class="rd">${issues.length ? ORDER.filter(count).map((s) => `${count(s)} ${SEV[s].word}`).join(' · ') : 'Quick automatic check of secrets, open endpoints and leftover files'}</div></span>
        <span class="rc">${SC.iconI('right')}</span></a></div></div>`,
    bind: (el) => el.querySelector('[data-hc-open]')?.addEventListener('click', (ev) => { ev.preventDefault(); openList(); }),
  }));

  SC.addPanelSection('item', (itemId) => {
    if (!itemId || typeof itemId !== 'string' || !issues.length) return '';
    const hits = [];
    issues.forEach((issue, idx) => {
      const inside = (issue.items || []).filter((id) => id === itemId || (SC.exists(id) && SC.chain(id).includes(itemId)));
      if (!inside.length) return;
      const exact = issue.notes && inside.includes(itemId) ? issue.notes[itemId] : '';
      hits.push(issueHtml(issue, idx, exact || (inside.length > 1 || inside[0] !== itemId ? `Affects ${SC.plural(inside.length, 'place')} in here` : '')));
    });
    if (!hits.length) return '';
    return { html: `<div class="sec"><h3>Health <span class="c">${hits.length}</span></h3>${hits.slice(0, 6).join('')}${hits.length > 6 ? `<div class="more" data-hc-open style="cursor:pointer">+${hits.length - 6} more in the health check</div>` : ''}</div>`, bind: (el) => { bindIssues(el); el.querySelector('[data-hc-open]')?.addEventListener('click', openList); } };
  });
})();
