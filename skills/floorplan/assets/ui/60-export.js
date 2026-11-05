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
  const T = (s, v) => { s = (SC.t || ((x) => x))(s); if (v) for (const k in v) s = s.replaceAll('{' + k + '}', v[k]); return s; };
  const A = SC.agent || { name: 'Claude', app: 'Claude Code' };
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
.xp-note { font-size: 12.5px; color: var(--text-3); line-height: 1.55; margin-top: 10px; }
.xp-err { font-size: 12.5px; color: var(--warn-text); background: var(--warn-bg); border-radius: 10px; padding: 8px 12px; margin-top: 10px; }
`;
  document.head.appendChild(style);
  SC.icons.export = '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>';

  // only what this map has; the extras that say how the app could be attacked are off unless ticked
  const PARTS = [
    { id: 'flows', label: T('Flows and the tour'), hint: T('The guided walkthroughs, including ones you requested.'), on: true, has: G.flows.length > 0 || (G.tour || []).length > 0 },
    { id: 'notes', label: T('Notes pinned to files'), hint: T('The notes shown on file cards.'), on: true, has: G.files.some((f) => f.note) },
    { id: 'recent', label: T('Recent work'), hint: T('What was just changed, and why.'), on: false, has: !!G.recent?.items?.length },
    PLAN
      ? { id: 'health', label: T('Design review'), hint: T('The decisions the plan still leaves open.'), on: false, has: !!G.health?.issues?.length }
      : { id: 'health', label: T('Health check'), hint: T('Lists the endpoints anyone can use and where secrets sit in the code (never their values). Only include it for people you trust.'), on: false, warn: true, has: !!G.health?.issues?.length },
  ].filter((p) => p.has);

  async function download(el, close) {
    const err = el.querySelector('.xp-err');
    const include = [...el.querySelectorAll('[data-xp]')].filter((c) => c.checked).map((c) => c.dataset.xp);
    // flows requested since the map was last built live only on this page so far
    const flows = G.flows.filter((f) => f.custom).map((f) => ({ id: f.id, title: f.title, description: f.description, steps: f.steps }));
    try {
      const r = await fetch('/api/export', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': S.token }, body: JSON.stringify({ include, flows }) });
      if (r.status === 403) throw new Error(T('The map’s server has restarted since this page opened. Reload the page and try again.'));
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || T('The map’s server couldn’t export it.'));
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'floorplan-map.html';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await r.blob());
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      close();
      SC.toast(T(`Downloaded ${name}`));
    } catch (e) {
      err.hidden = false;
      err.textContent = e.message === 'Failed to fetch' ? T('Couldn’t reach the map’s server. Ask {agent} to open the floorplan again, then try again.', { agent: A.name }) : e.message;
    }
  }

  function openExport() {
    if (!S) {
      SC.modal({
        title: T('Export a copy'),
        html: `<p>${T('Exporting needs the map’s server. Ask {agent} to “export the floorplan”, or run this in the project folder:', { agent: A.name })}</p><pre>${h(CMD)}</pre>`,
        actions: [{ label: T('Copy command'), primary: true, icon: 'copy', onClick: () => { SC.copy(CMD); SC.toast(T('Copied')); } }],
      });
      return;
    }
    const m = SC.modal({
      title: T('Export a copy'),
      html: `<p>${T('One HTML file with the whole map, to send to anyone. It opens in any browser with nothing to install, and has no Ask bar.')}</p>
        ${PARTS.length ? `<div class="xp-opts">${PARTS.map((p) => `<label class="xp-opt${p.warn ? ' warn' : ''}"><input type="checkbox" data-xp="${p.id}"${p.on ? ' checked' : ''}><div><b>${h(p.label)}</b><span>${h(p.hint)}</span></div></label>`).join('')}</div>` : ''}
        <p class="xp-note">${T('It shows how {name} is put together: every part, file and endpoint, and the names of the functions inside, but not the code itself.', { name: h(G.project.name) })}</p>
        <div class="xp-err" hidden></div>`,
      actions: [{ label: T('Download'), primary: true, icon: 'export', keepOpen: true, onClick: (close) => { download(m.el, close); } }],
    });
  }

  SC.addHeaderButton({ id: 'btn-export', label: T('Export'), icon: 'export', title: T('Export a copy of this map to share'), onClick: openExport });
})();
