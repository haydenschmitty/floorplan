// Screens lens: start from a page people recognise ("the checkout page") and see everything behind it:
// the parts on it, the requests it makes, the server code that answers them, the data and outside
// services involved. Data comes from graph.screens (scripts/lib/screens.mjs).
(() => {
  const SC = window.Floorplan;
  if (!SC) return;
  const G = SC.graph;
  // pages that only bounce you elsewhere have nothing behind them worth a board
  const screens = (G.screens || []).filter((s) => s && s.url && Array.isArray(s.behind) && s.behind.length && !(s.behind.length < 2 && /redirect/i.test(`${s.name} ${s.description}`)));
  if (!screens.length) return;
  const { h, hk } = SC;

  const style = document.createElement('style');
  style.textContent = `
#sc-menu { position: fixed; width: 340px; max-height: min(70vh, 580px); overflow: auto; transform-origin: top right; overscroll-behavior: contain; }
#sc-menu .sc-f { position: sticky; top: -6px; margin: -6px -6px 4px; padding: 10px 10px 6px; background: var(--menu-solid); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); z-index: 1; border-radius: 18px 18px 0 0; }
#sc-menu .sc-f input { width: 100%; height: 34px; border: 0; border-radius: 12px; padding: 0 12px; background: rgba(var(--ink), .06); color: var(--text); outline: none; transition: background .2s var(--ease), box-shadow .2s var(--ease); }
#sc-menu .sc-f input:focus { background: rgba(var(--ink), .08); box-shadow: 0 0 0 1px rgba(var(--ink), .14); }
#sc-menu .sc-g { padding: 10px 12px 4px; font-size: 12px; color: var(--text-3); }
#sc-menu .sc-r { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--text); padding: 9px 12px; border-radius: 12px; cursor: pointer; transition: background .15s var(--ease); }
#sc-menu .sc-r:hover, #sc-menu .sc-r.on { background: rgba(var(--ink), .07); }
#sc-menu .sc-r b { font-weight: 500; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#sc-menu .sc-r span { font-family: var(--mono); font-size: 11.5px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
#sc-menu .sc-none { padding: 14px 12px; color: var(--text-3); font-size: 12.5px; }
`;
  document.head.appendChild(style);

  // ---------- data ----------
  const topLabel = new Map(G.nodes.filter((n) => !n.parent).map((n) => [n.id, n.label]));
  const appName = (id) => topLabel.get(id) || (id === 'unassigned' ? 'Other' : id);
  const byApp = new Map();
  for (const s of screens) { if (!byApp.has(s.app)) byApp.set(s.app, []); byApp.get(s.app).push(s); }
  const byFile = new Map();
  for (const s of screens) { if (!byFile.has(s.file)) byFile.set(s.file, []); byFile.get(s.file).push(s); }
  // which screens each card shows up behind (for "Shown on these screens" in the details panel)
  const usedBy = new Map();
  for (const s of screens) for (const b of s.behind) {
    if (b.kind === 'screen' || b.id === 'f:' + s.file) continue;
    if (!usedBy.has(b.id)) usedBy.set(b.id, []);
    usedBy.get(b.id).push(s);
  }

  function showScreen(s) {
    closeMenu();
    const items = s.behind.filter((b) => SC.exists(b.id));
    // a short walkthrough: the screen → its first request → the server code → where it ends up
    const firstOf = (kind) => items.find((b) => b.kind === kind);
    const steps = [firstOf('screen'), firstOf('request'), firstOf('server'), firstOf('data') || firstOf('outside')].filter(Boolean);
    SC.showBoard({ kind: 'Screen', icon: 'ui', title: s.name, question: 'Everything behind ' + s.url, items, steps: steps.length >= 3 ? steps : [] });
  }

  // ---------- header menu ----------
  const menu = document.createElement('div');
  menu.id = 'sc-menu';
  menu.className = 'menu glass';
  document.body.appendChild(menu);
  let btn = null;
  const many = screens.length > 8;

  function renderList(q = '') {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (s) => !words.length || words.every((w) => `${s.name} ${s.url} ${appName(s.app)}`.toLowerCase().includes(w));
    let html = '', shown = 0;
    for (const [app, list] of byApp) {
      const rows = list.filter(hit);
      if (!rows.length) continue;
      if (byApp.size > 1) html += `<div class="sc-g">${h(appName(app))}</div>`;
      for (const s of rows) html += `<button class="sc-r" data-sc="${hk(s.id)}"><b>${h(s.name)}</b><span>${h(s.url)}</span></button>`;
      shown += rows.length;
    }
    if (!shown) html = `<div class="sc-none">No screen matches “${h(q)}”.</div>`;
    const list = menu.querySelector('.sc-l');
    list.innerHTML = html;
    list.querySelectorAll('[data-sc]').forEach((b) => b.onclick = (ev) => { ev.stopPropagation(); showScreen(screens.find((s) => s.id === b.dataset.sc)); });
    list.querySelector('.sc-r')?.classList.add('on');
  }
  function renderMenu() {
    menu.innerHTML = `${many ? '<div class="sc-f"><input id="sc-q" placeholder="Find a screen…" spellcheck="false" autocomplete="off"></div>' : ''}<div class="sc-l"></div>`;
    renderList('');
    const input = menu.querySelector('#sc-q');
    if (!input) return;
    input.oninput = () => renderList(input.value);
    input.onkeydown = (ev) => {
      const rows = [...menu.querySelectorAll('.sc-r')];
      const cur = rows.findIndex((r) => r.classList.contains('on'));
      if (ev.key === 'Enter' && rows[cur]) { ev.preventDefault(); rows[cur].click(); }
      else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const next = rows[Math.max(0, Math.min(rows.length - 1, cur + (ev.key === 'ArrowDown' ? 1 : -1)))];
        rows.forEach((r) => r.classList.toggle('on', r === next));
        next?.scrollIntoView({ block: 'nearest' });
      }
    };
  }
  function openMenu() {
    document.body.click(); // let the viewer close its own menus (Flows, filters)
    renderMenu();
    place();
    menu.classList.add('open');
    menu.querySelector('#sc-q')?.focus();
  }
  function place() {
    const r = btn.getBoundingClientRect();
    const w = Math.min(340, innerWidth - 16); // never wider than the screen
    menu.style.top = r.bottom + 8 + 'px';
    menu.style.width = w + 'px';
    menu.style.right = Math.min(Math.max(8, innerWidth - r.right), innerWidth - 8 - w) + 'px';
  }
  function closeMenu() { menu.classList.remove('open'); }
  const isOpen = () => menu.classList.contains('open');

  btn = SC.addHeaderButton({ id: 'screens-btn', label: 'Screens', icon: 'ui', title: 'Pick a screen of the app to see everything behind it', onClick: () => (isOpen() ? closeMenu() : openMenu()) });
  window.addEventListener('pointerdown', (ev) => { if (isOpen() && !menu.contains(ev.target) && !btn.contains(ev.target)) closeMenu(); }, true);
  window.addEventListener('keydown', (ev) => {
    if (!isOpen()) return;
    if (ev.key === 'Escape') { ev.stopImmediatePropagation(); ev.preventDefault(); closeMenu(); }
    else if (ev.target?.id !== 'sc-q') ev.stopPropagation(); // keep viewer shortcuts out of the open menu
  }, true);
  window.addEventListener('resize', () => { if (isOpen()) place(); });

  // ---------- details panel ----------
  const row = (s, label) => `<a class="row" data-sc="${hk(s.id)}"><span class="dot" style="background:var(--n-ui)"></span><span class="rt"><div class="rn">${h(label || s.name)}</div><div class="rp">${h(s.url)}</div></span></a>`;
  const bindRows = (el) => el?.querySelectorAll('[data-sc]').forEach((a) => a.addEventListener('click', (ev) => { ev.preventDefault(); showScreen(screens.find((s) => s.id === a.dataset.sc)); }));
  SC.addPanelSection('item', (id) => {
    if (typeof id !== 'string') return null;
    const own = id.startsWith('f:') ? byFile.get(id.slice(2)) || [] : [];
    const on = (usedBy.get(id) || []).filter((s) => !own.includes(s));
    if (!own.length && !on.length) return null;
    let html = '';
    if (own.length) html += `<div class="sec"><h3>This is a screen</h3><div class="list">${own.map((s) => row(s, 'See everything behind this screen')).join('')}</div></div>`;
    if (on.length) html += `<div class="sec"><h3>Behind these screens <span class="c">${on.length}</span></h3><div class="list">${on.slice(0, 8).map((s) => row(s)).join('')}</div></div>`;
    return { html, bind: bindRows };
  });
  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>Screens <span class="c">${screens.length}</span></h3><div class="list"><a class="row" data-sc-open><span class="dot" style="background:var(--n-ui)"></span><span class="rt"><div class="rn">Start from a screen</div><div class="rd">Pick a page of the app to see the parts on it, the requests it makes and the server code behind them.</div></span></a></div></div>`,
    bind: (el) => el?.querySelector('[data-sc-open]')?.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); openMenu(); }),
  }));

  // other features (the tour) can open a screen's board
  window.FloorplanScreens = { list: screens, show: showScreen, openMenu };
})();
