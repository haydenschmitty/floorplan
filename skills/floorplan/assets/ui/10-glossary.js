// floorplan glossary: explains the technical words a non-developer meets on the map.
// The first time a known term appears in a description (details panel, board title area), it gets a
// dotted underline; hovering or focusing it shows a one-sentence explanation. Off while
// "Show technical detail" is on. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  if (!SC) return;

  // [English name, English explanation, French name, French explanation, aliases...]. Aliases are
  // matched as whole words, ignoring case, except those marked with a leading "=" (matched exactly,
  // so "REST" doesn't fire on "the rest"). English and French aliases both match, whatever language
  // the map's descriptions are written in; the popover shows the viewer's language.
  const TERMS = [
    ['API', 'The way programs talk to each other: one asks for something (prices, an order) and the other answers.', 'API', 'La façon dont les programmes se parlent : l\'un demande quelque chose (des prix, une commande) et l\'autre répond.', 'API', 'APIs', 'API client', 'client API'],
    ['Endpoint', 'One specific request the app can receive, like "mark this order shipped"; each has its own web address.', 'Endpoint', 'Une requête précise que l\'app peut recevoir, comme « marquer cette commande expédiée » ; chacun a sa propre adresse web.', 'endpoint', 'endpoints'],
    ['Webhook', 'A message another service sends your app automatically when something happens there, like "a payment went through".', 'Webhook', 'Un message qu\'un autre service envoie automatiquement à ton app quand quelque chose s\'y passe, comme « un paiement est passé ».', 'webhook', 'webhooks'],
    ['Server', 'A computer in the cloud that runs your app\'s behind-the-scenes work and answers requests from the screens.', 'Serveur', 'Un ordinateur dans le cloud qui fait tourner le travail en coulisses de ton app et répond aux requêtes des écrans.', 'server', 'servers', 'main server', 'serveur', 'serveurs'],
    ['Frontend', 'The part of the app people see and click: the screens, buttons and forms in the browser.', 'Frontend', 'La partie de l\'app que les gens voient et où ils cliquent : les écrans, boutons et formulaires dans le navigateur.', 'frontend', 'front end', 'front-end'],
    ['Backend', 'The behind-the-scenes part of the app that stores the records, applies the rules and talks to other services.', 'Backend', 'La partie en coulisses de l\'app qui stocke les données, applique les règles et parle aux autres services.', 'backend', 'back end', 'back-end'],
    ['Database', 'Where the app keeps its records (products, orders, customers) so nothing is lost when it restarts.', 'Base de données', 'Là où l\'app garde ses données (produits, commandes, clients) pour que rien ne soit perdu quand elle redémarre.', 'database', 'databases', 'DB', 'base de données', 'bases de données'],
    ['Record', 'One saved entry in the database, like a single order or customer; a table is the list of all records of one kind.', 'Enregistrement', 'Une entrée enregistrée dans la base, comme une commande ou un client ; une table est la liste de tous les enregistrements d\'un type.', 'database record', 'database records', 'database table', 'database tables', 'enregistrement', 'enregistrements'],
    ['Model', 'In code, a model describes how one kind of record (an order, a customer) is stored in the database.', 'Modèle', 'En code, un modèle décrit comment un type d\'enregistrement (une commande, un client) est stocké dans la base.', 'model', 'models', 'ORM', 'ORM model', 'ORM models', 'data model', 'modèle', 'modèles'],
    ['Query', 'A question the app asks the database, like "all orders from today that haven\'t shipped".', 'Requête', 'Une question que l\'app pose à la base, comme « toutes les commandes du jour pas encore expédiées ».', 'query', 'queries'],
    ['Queue', 'A waiting line of tasks; work is dropped in and handled one by one in the background so nothing gets lost.', 'File d\'attente', 'Une file de tâches en attente ; le travail y est déposé puis traité un par un en arrière-plan pour ne rien perdre.', 'queue', 'queues', 'queued', 'outbox', 'message queue', 'file de messages'],
    ['Background job', 'A task that runs on its own behind the scenes, so people don\'t have to wait for it on screen.', 'Tâche de fond', 'Une tâche qui tourne toute seule en coulisses, sans faire attendre les gens à l\'écran.', 'background job', 'background jobs', 'background task', 'background tasks', 'worker', 'workers', 'tâche de fond', 'tâches de fond'],
    ['Scheduled job', 'A task that runs automatically on a timetable, like every hour or every night.', 'Tâche planifiée', 'Une tâche qui tourne automatiquement selon un horaire, comme toutes les heures ou chaque nuit.', 'cron', 'cron job', 'cron jobs', 'scheduled job', 'scheduled jobs', 'scheduler', 'tâche planifiée', 'tâches planifiées'],
    ['Environment variable', 'A setting stored outside the code, such as which database or account to use, so it can differ between test and live.', 'Variable d\'environnement', 'Un réglage stocké hors du code, comme quelle base ou quel compte utiliser, pour pouvoir différer entre test et production.', 'environment variable', 'environment variables', 'env var', 'env vars', '.env', 'variable d\'environnement', 'variables d\'environnement'],
    ['Secret', 'A password or key the app uses to sign in to another service; it must never be shared or put in the code.', 'Secret', 'Un mot de passe ou une clé que l\'app utilise pour se connecter à un autre service ; il ne doit jamais être partagé ni mis dans le code.', 'secret', 'secrets', 'API key', 'API keys', 'credentials', 'clé API', 'clés API'],
    ['Deploy', 'Putting a new version of the app live so people start using it.', 'Déploiement', 'Mettre en ligne une nouvelle version de l\'app pour que les gens commencent à l\'utiliser.', 'deploy', 'deploys', 'deployed', 'deployment', 'deployments', 'déployer', 'déploiement', 'déploiements'],
    ['Migration', 'A one-time change to how records are stored, like adding a new field to every order.', 'Migration', 'Un changement ponctuel de la façon dont les données sont stockées, comme ajouter un champ à chaque commande.', 'migration', 'migrations'],
    ['Cache', 'A saved copy of something kept close by so it loads faster instead of being worked out again.', 'Cache', 'Une copie gardée sous la main pour charger plus vite au lieu de tout recalculer.', 'cache', 'cached', 'caching', 'en cache'],
    ['Sign-in', 'Checking who someone is (usually with a password) before letting them in.', 'Connexion', 'Vérifier qui est quelqu\'un (en général avec un mot de passe) avant de le laisser entrer.', 'auth', 'authentication', 'login', 'log in', 'sign-in', 'sign in', 'authentification', 'se connecter'],
    ['Permissions', 'The rules for who is allowed to do what, like only managers issuing refunds.', 'Permissions', 'Les règles qui disent qui a le droit de faire quoi, comme seuls les managers peuvent rembourser.', 'permissions', 'authorization', 'roles', 'RBAC', 'rôles'],
    ['Session', 'How the app remembers you are signed in, so you don\'t have to type your password on every screen.', 'Session', 'Comment l\'app se souvient que tu es connecté, sans retaper ton mot de passe à chaque écran.', 'session', 'sessions'],
    ['Token', 'A temporary digital pass the app hands out after sign-in and checks on every request.', 'Jeton', 'Un laissez-passer numérique temporaire que l\'app délivre après la connexion et vérifie à chaque requête.', 'token', 'tokens', 'bearer token', 'access token', 'jeton', 'jetons'],
    ['SDK', 'A ready-made kit of code a company provides so apps can talk to its service more easily.', 'SDK', 'Un kit de code tout prêt fourni par une entreprise pour que les apps parlent plus facilement à son service.', 'SDK', 'SDKs'],
    ['Repository', 'The folder that holds all of a project\'s code and its full history of changes.', 'Dépôt', 'Le dossier qui contient tout le code d\'un projet et tout l\'historique de ses changements.', 'repository', 'repositories', 'repo', 'repos', 'dépôt', 'dépôts'],
    ['Component', 'A reusable building block of the screens, like a button, a table or a whole product editor.', 'Composant', 'Une brique réutilisable des écrans, comme un bouton, un tableau ou tout un éditeur de produit.', 'component', 'components', 'composant', 'composants'],
    ['Route', 'A web address the app answers: on the screens it\'s a page, on the server it\'s a kind of request.', 'Route', 'Une adresse web à laquelle l\'app répond : côté écrans c\'est une page, côté serveur un type de requête.', 'route', 'routes', 'routing', 'App Router'],
    ['Request', 'A message asking the server to do or fetch something; the server sends back a response with the result.', 'Requête', 'Un message qui demande au serveur de faire ou de chercher quelque chose ; le serveur renvoie une réponse avec le résultat.', 'request', 'requests', 'response', 'responses', 'requête', 'requêtes', 'réponse', 'réponses'],
    ['JSON', 'A simple text format programs use to send data to each other, like a labelled list.', 'JSON', 'Un format texte simple que les programmes utilisent pour s\'échanger des données, comme une liste étiquetée.', 'JSON'],
    ['REST', 'A common style for building APIs, where each web address stands for a kind of thing (orders, products).', 'REST', 'Un style courant pour construire des API, où chaque adresse web désigne un type de chose (commandes, produits).', '=REST', '=RESTful'],
    ['HTTP method', 'The kind of request: GET reads something, POST creates, PUT or PATCH changes, DELETE removes.', 'Méthode HTTP', 'Le type de requête : GET lit, POST crée, PUT ou PATCH modifie, DELETE supprime.', 'HTTP method', 'HTTP methods', '=GET', '=POST', '=PUT', '=PATCH', '=DELETE', 'méthode HTTP', 'méthodes HTTP'],
    ['HTTP', 'The language browsers and servers use to talk over the web; HTTPS is the encrypted version.', 'HTTP', 'Le langage que navigateurs et serveurs utilisent pour parler sur le web ; HTTPS est la version chiffrée.', 'HTTP', 'HTTPS'],
    ['CDN', 'A network of servers around the world that delivers images and files quickly from somewhere near the visitor.', 'CDN', 'Un réseau de serveurs dans le monde entier qui livre vite les images et fichiers depuis un endroit proche du visiteur.', 'CDN', 'CDNs'],
    ['Storage bucket', 'Cloud file storage for things like product images, uploads and exports.', 'Espace de stockage', 'Du stockage de fichiers dans le cloud pour les images produit, les uploads et les exports.', 'storage bucket', 'bucket', 'buckets', 'S3', 'GCS', 'Cloud Storage'],
    ['Pub/Sub', 'Google\'s message service: one part of the app posts an event and others pick it up to handle in the background.', 'Pub/Sub', 'Le service de messages de Google : une partie de l\'app publie un événement et d\'autres le récupèrent pour le traiter en arrière-plan.', 'Pub/Sub', 'PubSub'],
    ['MCP', 'A standard way to connect AI assistants (like Claude or ChatGPT) to an app so they can look things up in it.', 'MCP', 'Une façon standard de connecter des assistants IA (comme Claude ou ChatGPT) à une app pour qu\'ils puissent y chercher des infos.', 'MCP', 'MCP server', 'Model Context Protocol', 'serveur MCP'],
    ['Next.js', 'A popular toolkit for building websites and web apps with React.', 'Next.js', 'Une boîte à outils populaire pour construire des sites et apps web avec React.', 'Next.js', 'NextJS'],
    ['React', 'A popular library for building interactive screens out of reusable pieces.', 'React', 'Une bibliothèque populaire pour construire des écrans interactifs à partir de briques réutilisables.', '=React'],
    ['Flask', 'A Python toolkit for building web servers.', 'Flask', 'Une boîte à outils Python pour construire des serveurs web.', 'Flask'],
    ['SQLAlchemy', 'A Python toolkit that lets the code read and save database records without writing raw database commands.', 'SQLAlchemy', 'Une boîte à outils Python qui permet au code de lire et enregistrer des données sans écrire de commandes SQL brutes.', 'SQLAlchemy'],
    ['Postgres', 'A widely used database; RDS and Cloud SQL are Amazon\'s and Google\'s hosted versions of it.', 'Postgres', 'Une base de données très utilisée ; RDS et Cloud SQL sont les versions hébergées d\'Amazon et de Google.', 'Postgres', 'PostgreSQL', 'RDS', 'Cloud SQL'],
    ['Docker', 'A way to package an app with everything it needs so it runs the same on any computer or cloud.', 'Docker', 'Une façon d\'emballer une app avec tout ce qu\'il lui faut pour tourner pareil sur n\'importe quel ordinateur ou cloud.', 'Docker', 'container', 'containers', 'conteneur', 'conteneurs'],
    ['Cloud Run', 'Google\'s service for running an app\'s servers and background jobs in the cloud without managing machines.', 'Cloud Run', 'Le service de Google pour faire tourner les serveurs et tâches de fond d\'une app dans le cloud sans gérer de machines.', 'Cloud Run'],
    ['Middleware', 'A check every request passes through on its way in, such as "is this person signed in?".', 'Middleware', 'Un contrôle par lequel chaque requête passe en entrant, comme « cette personne est-elle connectée ? ».', 'middleware'],
    ['Blueprint', 'In Flask, a group of related requests bundled together, like all the order requests.', 'Blueprint', 'Dans Flask, un groupe de requêtes liées regroupées ensemble, comme toutes les requêtes de commandes.', 'blueprint', 'blueprints'],
    ['Tests', 'Automatic checks that the code still does what it should, run before changes go live.', 'Tests', 'Des vérifications automatiques que le code fait toujours ce qu\'il doit, lancées avant que les changements partent en ligne.', 'test suite', 'unit test', 'unit tests', 'pytest', 'Vitest', 'tests unitaires'],
    ['Script', 'A small program run by hand for a one-off job, like fixing or importing data.', 'Script', 'Un petit programme lancé à la main pour un travail ponctuel, comme corriger ou importer des données.', 'script', 'scripts'],
    ['OAuth', 'The standard behind "Sign in with…" buttons: it lets one app use another on your behalf without sharing your password.', 'OAuth', 'La norme derrière les boutons « Se connecter avec… » : elle permet à une app d\'en utiliser une autre en ton nom sans partager ton mot de passe.', 'OAuth'],
  ];

  const exact = new Map(), loose = new Map(), alts = [];
  TERMS.forEach(([en, enText, fr, frText, ...aliases], i) => {
    for (let a of aliases) {
      const strict = a.startsWith('=');
      if (strict) a = a.slice(1);
      (strict ? exact : loose).set(strict ? a : a.toLowerCase(), i);
      alts.push(a);
    }
  });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  alts.sort((a, b) => b.length - a.length);
  const RE = new RegExp(`(?<![\\w./-])(?:${alts.map(esc).join('|')})(?![\\w/]|-\\w|\\.\\w)`, 'gi');
  const termOf = (m) => exact.has(m) ? exact.get(m) : loose.has(m.toLowerCase()) ? loose.get(m.toLowerCase()) : -1;

  // Where to look, and what to leave alone.
  const TARGETS = '.pd, .rd, .callout';
  const SKIP = 'a[href], button, code, pre, kbd, samp, input, textarea, select, [contenteditable], .tag, .rp, .pp, .method, .kbd, .sc-term, [data-noglossary]';
  const CLICKABLE = 'a, [data-go], [data-sel], [data-flow], [data-open], [role="button"]';
  const isMono = (el) => /mono|monospace/i.test(el.style?.fontFamily || '');

  function annotate(scope, targets) {
    if (!scope || SC.technical()) return;
    const used = new Set([...scope.querySelectorAll('.sc-term')].map((s) => +s.dataset.term)); // max one per term per scope
    const skipped = (from, stop) => { for (let p = from; p && p !== stop; p = p.parentElement) if (p.matches(SKIP) || isMono(p)) return true; return false; };
    for (const el of targets) {
      if (skipped(el, scope)) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (t) => !t.nodeValue.trim() || skipped(t.parentElement, el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      const texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      for (const t of texts) wrapIn(t, used);
    }
  }
  function wrapIn(textNode, used) {
    let node = textNode;
    while (node) {
      RE.lastIndex = 0;
      let m, hit = null;
      while ((m = RE.exec(node.nodeValue))) {
        const i = termOf(m[0]);
        if (i >= 0 && !used.has(i)) { hit = { m, i }; break; }
      }
      if (!hit) return;
      used.add(hit.i);
      const word = node.splitText(hit.m.index);
      const rest = word.splitText(hit.m[0].length);
      const span = document.createElement('span');
      span.className = 'sc-term';
      span.dataset.term = String(hit.i);
      if (!word.parentElement.closest(CLICKABLE)) span.tabIndex = 0; // inside clickable rows: hover only, clicks pass through
      word.replaceWith(span);
      span.appendChild(word);
      node = rest;
    }
  }
  function strip(scope) {
    if (!scope) return;
    for (const s of scope.querySelectorAll('.sc-term')) s.replaceWith(...s.childNodes);
    scope.normalize();
  }

  const panelEl = () => document.getElementById('panel');
  const contextEl = () => document.getElementById('context');
  const doPanel = () => { const p = panelEl(); if (p) annotate(p, p.querySelectorAll(TARGETS)); };
  const doContext = () => { const c = contextEl(); if (c) annotate(c, c.querySelectorAll('p, .callout')); };

  // Run after the viewer and any other extension listeners have finished filling the DOM.
  SC.on('panel', () => { hide(true); queueMicrotask(doPanel); });
  SC.on('render', () => { hide(true); queueMicrotask(doContext); });
  SC.on('technical', (on) => {
    hide(true);
    if (on) { strip(panelEl()); strip(contextEl()); }
    else { queueMicrotask(() => { strip(panelEl()); strip(contextEl()); doPanel(); doContext(); }); }
  });

  // ---------- popover ----------
  const style = document.createElement('style');
  style.textContent = `
.sc-term { pointer-events: auto; cursor: help; border-radius: 4px; text-decoration-line: underline; text-decoration-style: dotted; text-decoration-thickness: 1px; text-underline-offset: 3px;
  text-decoration-color: rgba(var(--ink), .32); text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); transition: text-decoration-color .2s var(--ease), color .2s var(--ease); }
.sc-term:hover, .sc-term.on { text-decoration-color: currentColor; color: var(--text); }
.callout .sc-term:hover, .callout .sc-term.on { color: inherit; }
.sc-term:focus { outline: none; }
.sc-term:focus-visible { box-shadow: 0 0 0 2px var(--focus); }
#sc-gloss { position: fixed; left: 0; top: 0; z-index: 55; max-width: 280px; padding: 11px 13px; border-radius: 14px; font-size: 12.5px; line-height: 1.5; color: var(--text-2);
  pointer-events: none; opacity: 0; transform: translateY(3px); transition: opacity .15s var(--ease), transform .25s var(--ease); }
#sc-gloss.on { opacity: 1; transform: none; }
#sc-gloss b { display: block; color: var(--text); font-weight: 600; margin-bottom: 2px; }`;
  document.head.appendChild(style);

  const pop = document.createElement('div');
  pop.id = 'sc-gloss';
  pop.className = 'glass';
  pop.setAttribute('role', 'tooltip');
  document.body.appendChild(pop);

  let current = null, showT = 0, hideT = 0;
  function show(el) {
    clearTimeout(hideT);
    if (current === el) return;
    const term = TERMS[+el.dataset.term];
    if (!term) return;
    const fr = SC.lang?.() === 'fr';
    const name = fr ? term[2] || term[0] : term[0];
    const text = fr ? term[3] || term[1] : term[1];
    current?.classList.remove('on'); current?.removeAttribute('aria-describedby');
    current = el;
    el.classList.add('on');
    el.setAttribute('aria-describedby', 'sc-gloss');
    pop.innerHTML = `<b>${SC.h(name)}</b>${SC.h(text)}`;
    const r = el.getClientRects()[0] || el.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 8;
    const x = Math.max(12, Math.min(r.left, innerWidth - pw - 12));
    const below = r.bottom + gap + ph <= innerHeight - 12;
    const y = below ? r.bottom + gap : Math.max(12, r.top - gap - ph);
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
    pop.classList.add('on');
  }
  function hide(now) {
    clearTimeout(showT); clearTimeout(hideT);
    const go = () => { pop.classList.remove('on'); current?.classList.remove('on'); current?.removeAttribute('aria-describedby'); current = null; };
    if (now === true) go(); else hideT = setTimeout(go, 90);
  }
  const termAt = (ev) => ev.target instanceof Element ? ev.target.closest('.sc-term') : null;
  document.addEventListener('mouseover', (ev) => { const t = termAt(ev); if (!t) return; clearTimeout(showT); showT = setTimeout(() => show(t), current ? 0 : 140); });
  document.addEventListener('mouseout', (ev) => { const t = termAt(ev); if (t && !t.contains(ev.relatedTarget)) { clearTimeout(showT); hide(); } });
  document.addEventListener('focusin', (ev) => { const t = termAt(ev); if (t) show(t); });
  document.addEventListener('focusout', (ev) => { if (termAt(ev)) hide(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && current) hide(true); });
  document.addEventListener('scroll', () => { if (current) hide(true); }, true);
  addEventListener('resize', () => { if (current) hide(true); });

  // initial pass, in case the first render/panel happened before this script ran
  if (document.readyState !== 'loading') queueMicrotask(() => { doPanel(); doContext(); });
})();
