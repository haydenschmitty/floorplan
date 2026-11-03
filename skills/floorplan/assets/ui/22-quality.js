// Code quality: the details behind the green-to-red coloring. The core viewer paints the cards and
// owns the "Color by code quality" switch; this adds the panel sections that explain a score:
// the riskiest places on the overview, and the reasons plus a bar per measure on any scored card.
// Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const Q = SC && SC.quality && SC.quality.data;
  if (!Q || !Object.keys(Q.files).length) return;
  const { h } = SC;

  const MEASURES = { complexity: 'Tangled code', maintainability: 'Size and readability', duplication: 'Copied code', slop: 'Careless code', deadEnd: 'Unused' };
  const color = (s) => `hsl(${SC.quality.hue(s)} 72% var(--ql))`;
  const dot = (s) => `<span class="dot" style="background:${color(s)}"></span>`;

  const style = document.createElement('style');
  style.textContent = `
    .qb { display: grid; grid-template-columns: 1fr 34px; gap: 4px 10px; align-items: center; font-size: 12.5px; color: var(--text-2); margin: 4px 0 10px; }
    .qb .bar { grid-column: 1 / 2; height: 5px; border-radius: 3px; background: rgba(var(--ink), .08); overflow: hidden; }
    .qb .bar i { display: block; height: 100%; border-radius: 3px; }
    .qb .v { text-align: right; color: var(--text-3); }
    .qwhy { margin: 6px 0 0; padding-left: 18px; color: var(--text-2); font-size: 12.5px; line-height: 1.55; }
    .qnote { color: var(--text-3); font-size: 12px; line-height: 1.5; margin-top: 8px; }
  `;
  document.head.appendChild(style);

  const scoreRow = (id, s, extra) => {
    const i = SC.info(id);
    return `<a class="row" data-go="${h(id)}" title="${h(i.path || '')}">${dot(s)}<span class="rt"><div class="rn">${h(i.name)}</div>${extra ? `<div class="rd">${h(extra)}</div>` : ''}</span><span class="rc" style="color:${color(s)};font-weight:600">${s}</span></a>`;
  };

  // overview: the ten files most worth a look, worst first
  const worst = Object.entries(Q.files).filter(([p, f]) => f.s > 33 && SC.exists('f:' + p)).sort((a, b) => b[1].s - a[1].s).slice(0, 10);
  SC.addPanelSection('overview', () => {
    const all = Object.values(Q.files);
    const risky = all.filter((f) => f.s > 66).length;
    const rows = worst.map(([p, f]) => scoreRow('f:' + p, f.s, (f.why && f.why[0]) || ''));
    return {
      html: `<div class="sec"><h3>Code quality <span class="c">${all.length} files scored</span></h3>
        ${rows.length ? `<div class="list">${rows.join('')}</div>` : '<div class="qnote">Nothing stands out: every scored file looks mostly good.</div>'}
        <div class="qnote">${risky ? `${risky} ${risky === 1 ? 'file is' : 'files are'} high risk. ` : ''}Scores run from 0 (healthy) to 100 (risky) and are quick automatic estimates, not verdicts. Turn on <b>Color by code quality</b> in the filters menu to see them on the map.</div></div>`,
    };
  });

  // any scored card: the score, a bar per measure, and why
  SC.addPanelSection('item', (itemId) => {
    if (!itemId || typeof itemId !== 'string') return '';
    const q = SC.quality.of(itemId);
    if (!q) return '';
    const band = SC.quality.band(q.s).label;
    const bars = q.metrics ? `<div class="qb">${Object.entries(q.metrics).filter(([k]) => MEASURES[k] && (k !== 'deadEnd' || q.metrics[k])).map(([k, v]) => `<span>${MEASURES[k]}</span><span></span><span class="bar"><i style="width:${Math.max(v, 3)}%;background:${color(v)}"></i></span><span class="v">${v}</span>`).join('')}</div>` : '';
    const why = q.why && q.why.length ? `<ul class="qwhy">${q.why.map((w) => `<li>${h(w)}</li>`).join('')}</ul>` : '';
    const worstRow = q.worst && SC.exists('f:' + q.worst) ? `<div class="list" style="margin-top:8px"><div class="qnote" style="margin:0 0 4px">Riskiest file in here</div>${scoreRow('f:' + q.worst, Q.files[q.worst].s, (Q.files[q.worst].why || [])[0] || '')}</div>` : '';
    return { html: `<div class="sec"><h3>Code quality <span class="c" style="color:${color(q.s)}">${h(band)} · ${q.s}</span></h3>${bars}${why}${worstRow}</div>` };
  });
})();
