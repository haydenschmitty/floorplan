// Export: a copy of the map to share as one HTML file, for people without Claude or Codex. The map's server
// (serve.mjs) builds it: the same page without the Ask bar, requests for Claude or Codex, or links into this
// computer, plus the extras ticked here. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  if (!SC || SC.exported) return;
  const S = window.FLOORPLAN_SERVER;
  // opened in the Claude app: there's no map folder to export from
  if (!S && location.protocol !== 'file:') return;
  const { h } = SC;
  const G = SC.graph;
  const PLAN = !!G.meta.blueprint;
  const CMD = 'node floorplan/serve.mjs --export';

  const style = document.createElement('style');
  style.textContent = `
.xp-opts { display: flex; flex-direction: column; gap: 2px; margin: 14px 0 4px; }
.xp-opt { display: flex; gap: 12px; align-items: flex-start; padding: 10px 12px; border-radius: 12px; cursor: pointer; }
.xp-opt:hover { background: rgba(var(--ink), .05); }
.xp-opt input { margin: 3px 0 0; width: 16px; height: 16px; accent-color: var(--accent); flex: none; cursor: pointer; }
.xp-opt b { display: block; font-weight: 500; color: var(--text); }
.xp-opt span { display: block; font-size: 12.5px; color: var(--text-3); line-height: 1.5; }
.xp-opt.warn span { color: var(--warn-text); }
.xp-docs { padding: 0 12px 6px 40px; }
.xp-field { display: flex; flex-direction: column; gap: 4px; padding: 6px 0 4px; }
.xp-field b { font-weight: 500; color: var(--text); }
.xp-field select { font: inherit; padding: 6px 8px; border-radius: 8px; max-width: 100%; }
.xp-note { font-size: 12.5px; color: var(--text-3); line-height: 1.55; margin-top: 10px; }
.xp-err { font-size: 12.5px; color: var(--warn-text); background: var(--warn-bg); border-radius: 10px; padding: 8px 12px; margin-top: 10px; }
`;
  document.head.appendChild(style);
  SC.icons.export = '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>';

  // only what this map has, as it is when the dialog opens; the extras that say how the app could be attacked are off unless ticked
  const exportParts = () => [
    { id: 'flows', label: 'Flows and the tour', hint: 'The guided walkthroughs, including ones you requested.', on: true, has: G.flows.length > 0 || (G.tour || []).length > 0 },
    { id: 'notes', label: 'Notes pinned to files', hint: 'The notes shown on file cards.', on: true, has: G.files.some((f) => f.note) },
    { id: 'recent', label: 'Recent work', hint: 'What was just changed, and why.', on: false, has: !!G.recent?.items?.length },
    PLAN
      ? { id: 'health', label: 'Design review', hint: 'The decisions the plan still leaves open.', on: false, has: !!G.health?.issues?.length }
      : { id: 'health', label: 'Health check', hint: 'Lists the endpoints anyone can use and where secrets sit in the code (never their values). Only include it for people you trust.', on: false, warn: true, has: !!G.health?.issues?.length },
  ].filter((p) => p.has);

  // where a docs copy can open: the overview, then every part that opens (parents before their children), named by where it sits
  function startViews() {
    const kids = new Map();
    const ids = new Set(G.nodes.map((n) => n.id));
    for (const n of G.nodes) {
      const key = n.parent && ids.has(n.parent) ? n.parent : '';
      if (!kids.has(key)) kids.set(key, []);
      kids.get(key).push(n);
    }
    const out = [{ value: 'root', label: 'Overview' }];
    const walk = (key, trail) => {
      for (const n of kids.get(key) || []) {
        const path = [...trail, n.label];
        // outside services and parts with nothing inside open a blank board, so they aren't offered; their openable children still are
        if (SC.children('n:' + n.id).length > 0) out.push({ value: 'n:' + n.id, label: path.join(' › ') });
        walk(n.id, path);
      }
    };
    walk('', []);
    return out;
  }

  async function download(el, close) {
    const err = el.querySelector('.xp-err');
    const include = [...el.querySelectorAll('[data-xp]')].filter((c) => c.checked).map((c) => c.dataset.xp);
    // flows requested since the map was last built live only on this page so far
    const flows = G.flows.filter((f) => f.custom).map((f) => ({ id: f.id, title: f.title, description: f.description, steps: f.steps }));
    const body = { include, flows };
    if (el.querySelector('[data-xp-docs]')?.checked) {
      body.embed = true;
      body.startView = el.querySelector('[data-xp-start]')?.value || 'root';
      body.showDescription = !!el.querySelector('[data-xp-desc]')?.checked;
    }
    try {
      const r = await fetch('/api/export', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': S.token }, body: JSON.stringify(body) });
      if (r.status === 403) throw new Error('The map’s server has restarted since this page opened. Reload the page and try again.');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The map’s server couldn’t export it.');
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'floorplan-map.html';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob());
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      close();
      SC.toast(`Downloaded ${name}`);
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message === 'Failed to fetch' ? 'Couldn’t reach the map’s server. Ask Claude or Codex to open the floorplan again, then try again.' : e.message;
    }
  }

  function openExport() {
    if (!S) {
      SC.modal({
        title: 'Export a copy',
        html: `<p>Exporting needs the map’s server. Ask Claude or Codex to “export the floorplan”, or run this in the project folder:</p><pre>${h(CMD)}</pre><p>Add <code>--embed</code> to make a copy for a page of your docs.</p>`,
        actions: [{ label: 'Copy command', primary: true, icon: 'copy', onClick: () => { SC.copy(CMD); SC.toast('Copied'); } }],
      });
      return;
    }
    const parts = exportParts();
    const m = SC.modal({
      title: 'Export a copy',
      html: `<p>One HTML file with the whole map, to send to anyone. It opens in any browser with nothing to install, and has no Ask bar.</p>
        ${parts.length ? `<div class="xp-opts">${parts.map((p) => `<label class="xp-opt${p.warn ? ' warn' : ''}"><input type="checkbox" data-xp="${p.id}"${p.on ? ' checked' : ''}><div><b>${h(p.label)}</b><span>${h(p.hint)}</span></div></label>`).join('')}</div>` : ''}
        <div class="xp-opts">
          <label class="xp-opt"><input type="checkbox" data-xp-docs><div><b>For a docs page</b><span>Made to sit inside a page of your docs: it won’t take over the page’s back button or scrolling. Like <code>--export --embed</code>.</span></div></label>
          <div class="xp-docs" data-xp-docs-opts hidden>
            <label class="xp-field"><b>Opens on</b><select data-xp-start>${startViews().map((v) => `<option value="${h(v.value)}"${v.value === 'root' ? ' selected' : ''}>${h(v.label)}</option>`).join('')}</select></label>
            <label class="xp-opt"><input type="checkbox" data-xp-desc><div><b>Show project description</b><span>The short summary of what ${h(G.project.name)} is, at the top of the map.</span></div></label>
          </div>
        </div>
        <p class="xp-note">It shows how ${h(G.project.name)} is put together: every part, file and endpoint, and the names of the functions inside, but not the code itself.</p>
        <div class="xp-err" hidden></div>`,
      actions: [{ label: 'Download', primary: true, icon: 'export', keepOpen: true, onClick: (close) => { download(m.el, close); } }],
    });
    const docs = m.el.querySelector('[data-xp-docs]');
    const opts = m.el.querySelector('[data-xp-docs-opts]');
    docs.addEventListener('change', () => { opts.hidden = !docs.checked; });
  }

  SC.addHeaderButton({ id: 'btn-export', label: 'Export', icon: 'export', title: 'Export a copy of this map to share', onClick: openExport });
})();
