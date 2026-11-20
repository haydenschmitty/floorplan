// Floorplan Cloud waitlist: after the map has been open a couple of minutes, a corner card asks once
// whether you'd like an email when Floorplan Cloud launches. Nothing leaves your machine unless you
// click "Notify me", and then only the email in the box and "just me" or "with my team". Only shown
// when the map is served by serve.mjs, which keeps the answer in ~/.floorplan/settings.json.
(() => {
  const SC = window.Floorplan;
  const S = window.FLOORPLAN_SERVER;
  if (!SC || !S) return;
  const { h } = SC;
  const AFTER = 120; // seconds of the map being on screen
  const PRIVACY = 'https://github.com/haydenschmitty/floorplan/blob/main/docs/privacy-and-security.md#floorplan-cloud-waitlist';
  const api = (p, body) => fetch('/api/cloud/' + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-floorplan-token': S.token }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());

  const style = document.createElement('style');
  style.textContent = `
    #cloud-card { position: fixed; left: 16px; bottom: 70px; width: 320px; z-index: 20; padding: 18px 18px 16px; border-radius: var(--r-panel);
      animation: sheetIn .45s var(--ease); transition: opacity .25s var(--ease); }
    #cloud-card.tucked { opacity: 0; pointer-events: none; }
    #cloud-card .cx { position: absolute; top: 10px; right: 10px; width: 30px; height: 30px; }
    #cloud-card .ce { font-size: 11.5px; font-weight: 600; color: var(--recent); letter-spacing: .02em; }
    #cloud-card h3 { margin: 4px 0 0; font-size: 16px; font-weight: 600; color: var(--text); padding-right: 24px; }
    #cloud-card p { margin: 8px 0 0; color: var(--text-2); font-size: 13px; line-height: 1.55; }
    #cloud-card .ca { display: flex; gap: 6px; margin-top: 14px; align-items: center; flex-wrap: wrap; }
    #cloud-card .ca .btn { height: 32px; font-size: 13px; }
    #cloud-card .cl { background: none; border: 0; padding: 0; color: var(--text-3); font: inherit; font-size: 12px; cursor: pointer; margin-left: auto; }
    #cloud-card .cl:hover { color: var(--text-2); }
    #cloud-card .co { display: grid; gap: 6px; margin-top: 12px; }
    #cloud-card .co button { text-align: left; border: 0; border-radius: 14px; padding: 10px 12px; background: rgba(var(--ink), .05); color: var(--text); cursor: pointer; font: inherit; transition: background .2s var(--ease); }
    #cloud-card .co button:hover { background: rgba(var(--ink), .1); }
    #cloud-card .co b { display: block; font-size: 13.5px; font-weight: 500; }
    #cloud-card .co span { display: block; color: var(--text-3); font-size: 12px; margin-top: 2px; }
    #cloud-card input { width: 100%; box-sizing: border-box; margin-top: 12px; height: 38px; padding: 0 12px; border-radius: var(--r-ctl); border: 1px solid var(--hair-2);
      background: var(--well); color: var(--text); font: inherit; font-size: 13.5px; outline: none; }
    #cloud-card input:focus { border-color: rgba(var(--ink), .3); }
    #cloud-card .cm { margin-top: 8px; font-size: 12px; color: var(--text-3); min-height: 0; }
    #cloud-card .cm.err { color: var(--sev-high); }
    #cloud-card .cf { margin-top: 12px; font-size: 11.5px; line-height: 1.5; color: var(--text-3); }
    #cloud-card .cf a { color: var(--text-2); }
  `;
  document.head.appendChild(style);

  let card = null;
  const answer = { use: null };
  const close = () => { card?.remove(); card = null; };
  const later = () => { api('dismiss', { forever: false }).catch(() => {}); close(); };
  const never = () => { api('dismiss', { forever: true }).catch(() => {}); close(); };

  function view(html, bind) {
    card.innerHTML = `<button class="btn icon cx" data-x title="Close">${SC.iconI('x')}</button>${html}`;
    card.querySelector('[data-x]').onclick = card.dataset.done ? close : later;
    bind?.(card);
  }

  function pitch() {
    view(`<div class="ce">Coming soon</div><h3>Floorplan Cloud</h3>
      <p>One shared map for your whole team: notes everyone can see, kept in sync with GitHub and updated on every push.</p>
      <p>Want an email when it launches?</p>
      <div class="ca"><button class="btn primary" data-yes>Let me know</button><button class="btn soft" data-later>Not now</button><button class="cl" data-never>Don't ask again</button></div>`,
    (el) => { el.querySelector('[data-yes]').onclick = use; el.querySelector('[data-later]').onclick = later; el.querySelector('[data-never]').onclick = never; });
  }

  function use() {
    view(`<div class="ce">Floorplan Cloud</div><h3>How would you use it?</h3>
      <div class="co"><button data-use="solo"><b>Just me</b><span>A map of my own projects</span></button><button data-use="team"><b>With my team</b><span>One shared map we all work from</span></button></div>`,
    (el) => el.querySelectorAll('[data-use]').forEach((b) => b.onclick = () => { answer.use = b.dataset.use; email(); }));
  }

  function email() {
    view(`<div class="ce">Floorplan Cloud</div><h3>Where should we email you?</h3>
      <input type="email" placeholder="you@example.com" autocomplete="email" spellcheck="false" maxlength="254">
      <div class="cm"></div>
      <div class="ca"><button class="btn primary" data-send>Notify me</button>${S.cli && S.engine === 'claude' ? '<button class="btn soft" data-claude>Use my Claude email</button>' : ''}</div>
      <div class="cf">Only this email and your answer (${answer.use === 'team' ? 'with my team' : 'just me'}) are sent, to a private Google Sheet kept by Floorplan's maker. It's used only to tell you when Floorplan Cloud launches. <a href="${PRIVACY}" target="_blank" rel="noopener">Details</a></div>`,
    (el) => {
      const input = el.querySelector('input'), msg = el.querySelector('.cm'), send = el.querySelector('[data-send]');
      const say = (t, err) => { msg.textContent = t || ''; msg.classList.toggle('err', !!err); };
      const mine = el.querySelector('[data-claude]');
      if (mine) mine.onclick = async () => {
        mine.disabled = true; say('Looking up your Claude Code account…');
        try {
          const r = await api('claude-email', {});
          if (r.email) { input.value = r.email; say(''); input.focus(); } else say('Claude Code isn\'t signed in with a Claude account here. Type an email instead.');
        } catch { say('Couldn\'t ask Claude Code. Type an email instead.'); }
        mine.disabled = false;
      };
      const submit = async () => {
        const v = input.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) { say('That doesn\'t look like an email address.', true); input.focus(); return; }
        send.disabled = true; say('Sending…');
        try {
          const r = await api('join', { email: v, use: answer.use });
          if (r.ok) return done(v);
          say(r.error === 'bad_email' ? 'That doesn\'t look like an email address.' : r.error === 'rate_limited' ? 'Too many sign-ups right now. Try again in a little while.' : 'Couldn\'t send that. Check your connection and try again.', true);
        } catch { say('Couldn\'t send that. Check your connection and try again.', true); }
        send.disabled = false;
      };
      send.onclick = submit;
      input.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') submit(); };
      input.focus();
    });
  }

  function done(v) {
    card.dataset.done = '1';
    view(`<div class="ce">Floorplan Cloud</div><h3>You're on the list</h3><p>We'll email <b>${h(v)}</b> when Floorplan Cloud launches. Thanks!</p>`);
    setTimeout(close, 8000);
  }

  // busy with something else? wait: a tour, a flow, a question, a dialog or search
  const busy = () => window.FloorplanTour?.active?.() || SC.state.flow || document.querySelector('#ask .stop, #modal.open, #palette.open');
  let seen = 0, asked = false;
  const timer = setInterval(async () => {
    if (card) { card.classList.toggle('tucked', !!(document.querySelector('#ask-sheet') && !document.querySelector('#ask-sheet').hidden)); return; }
    if (asked || document.visibilityState !== 'visible' || ++seen < AFTER || busy()) return;
    asked = true;
    // another tab may have answered in the meantime
    const ok = await api('prompt').then((r) => r.show).catch(() => false);
    if (!ok || card) { clearInterval(timer); return; }
    card = document.createElement('div');
    card.id = 'cloud-card'; card.className = 'glass';
    card.addEventListener('keydown', (ev) => ev.stopPropagation());
    document.body.appendChild(card);
    pitch();
  }, 1000);
  // nothing to ask (already answered, or turned off): stop counting
  api('prompt').then((r) => { if (!r.show) clearInterval(timer); }).catch(() => clearInterval(timer));

  // for testing and demos: ask now instead of after two minutes
  window.FloorplanCloud = { show: () => { seen = AFTER; } };
})();
