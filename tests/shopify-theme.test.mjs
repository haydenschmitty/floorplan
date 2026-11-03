// Shopify themes: Liquid files and JSON templates linked by name, apps as packages, templates as Screens.
// Only inside a folder with layout/theme.liquid; elsewhere .liquid and templates/*.json are left as they were.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, makeProject, run, readJson, readGraph, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const { classify, themeRoots } = await lib('common.mjs');

// a theme beside a server, as in a monorepo
const THEME = {
  'storefront/layout/theme.liquid': [
    `<link href="{{ 'theme.css' | asset_url }}" rel="stylesheet">`,
    `{% sections 'header-group' %}`,
    `{{ content_for_layout }}`,
    `<script src="{{ 'theme.js' | asset_url }}" defer></script>`,
  ].join('\n'),
  'storefront/sections/header-group.json': JSON.stringify({ type: 'header', name: 'Header group', sections: { header: { type: 'header', settings: {} } }, order: ['header'] }),
  'storefront/sections/header.liquid': `{%- render\n  'logo',\n  size: 'small'\n-%}\n{% schema %}{ "name": "Header", "blocks": [{ "type": "menu", "name": "Menu" }] }{% endschema %}`,
  'storefront/sections/main-product.liquid': [
    `{% liquid`,
    `  render 'price', product: product`,
    `%}`,
    `{% comment %}{% render 'old-badge' %}{% endcomment %}`,
    `<script>fetch('/apps/loyalty/points', { method: 'POST' })</script>`,
    `<a href="/collections/all">All</a> {% assign links = '[{"url": "/collections/sale"}]' %}`,
    `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
    `{% schema %}{ "name": "t:sections.main-product.name", "blocks": [{ "type": "@app" }, { "type": "price" }] }{% endschema %}`,
  ].join('\n'),
  'storefront/sections/apps.liquid': `{% content_for 'blocks' %}`,
  'storefront/snippets/price.liquid': `{% comment %}\n  Renders a product's price, with the sale price when there is one.\n  Accepts:\n  - product: {Object}\n{% endcomment %}\n<span>{{ product.price | money }}</span>`,
  'storefront/snippets/logo.liquid': `<img src="{{ settings.logo | image_url }}">`,
  'storefront/snippets/badge.liquid': `{% doc %}\n  Renders a small label over a product card.\n\n  @param {string} label - The text to show\n  @example\n  {% render 'logo' %}\n{% enddoc %}\n<span>{{ label }}</span>`,
  'storefront/snippets/signup.liquid': `<form></form>`,
  'storefront/snippets/unused-badge.liquid': `<span class="badge">New</span>`,
  'storefront/blocks/review-stars.liquid': `<div class="stars"></div>`,
  'storefront/assets/theme.css.liquid': `body { color: {{ settings.color_text }}; }`,
  'storefront/assets/theme.js': `console.log('theme');`,
  'storefront/templates/index.json': JSON.stringify({ sections: { custom: { type: 'apps', settings: { custom_liquid: `{% render 'signup' %}<p class="x">{% comment %}{% render 'logo' %}{% endcomment %}</p>` } } }, order: ['custom'] }),
  'storefront/templates/product.json': `/* Shopify writes this notice */\n` + JSON.stringify({ sections: { main: { type: 'main-product', blocks: { price: { type: 'price' }, stars: { type: 'review-stars' }, reviews: { type: 'shopify://apps/product-reviews/blocks/badge/1a2b' } } } }, order: ['main'] }),
  'storefront/templates/collection.sale.json': JSON.stringify({ sections: { ai: { type: '_blocks', blocks: { a: { type: 'ai_gen_block_1' } } } }, order: ['ai'] }),
  'storefront/templates/customers/account.liquid': `{% render 'price' %}`,
  'storefront/config/settings_data.json': JSON.stringify({ current: { blocks: { 1: { type: 'shopify://apps/loyalty-rewards/blocks/embed/1', disabled: false } } } }),
  // not a theme: a server that keeps email templates as JSON and a page template in Liquid
  'api/templates/welcome.json': JSON.stringify({ subject: 'Welcome', sections: { body: { type: 'text' } } }),
  'api/templates/page.liquid': `{% render 'footer' %}`,
  'api/server.js': `console.log('api');`,
};

let root, graph, scan;
before(() => {
  root = makeProject(THEME, { repos: ['.'], arch: {
    project: { name: 'shop', summary: 'Test fixture.' },
    nodes: [
      { id: 'theme', label: 'Storefront theme', kind: 'ui', summary: 'The theme.', paths: ['storefront/**'] },
      { id: 'api', label: 'Server', kind: 'service', summary: 'The server.', paths: ['api/**'] },
    ],
  } });
  run('scan.mjs', root);
  scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

const linked = (a, b) => graph.links.some((l) => l.k === 'import' && l.a === 'f:storefront/' + a && l.b === 'f:storefront/' + b);

test('a theme is a folder with layout/theme.liquid; only there are Liquid and page JSON read as a theme', () => {
  assert.deepEqual([...themeRoots(['layout/theme.liquid', 'shop/layout/theme.liquid', 'docs/layout/theme.liquid.md'])], ['', 'shop/']);
  const themes = new Set(['storefront/']);
  assert.deepEqual(classify('storefront/templates/product.json', 100, { themes }), { category: 'code', lang: 'liquid' });
  assert.deepEqual(classify('storefront/sections/header-group.json', 100, { themes }), { category: 'code', lang: 'liquid' });
  assert.deepEqual(classify('storefront/snippets/price.liquid', 100, { themes }), { category: 'code', lang: 'liquid' });
  assert.equal(classify('storefront/locales/en.default.json', 100, { themes }).category, 'data');
  assert.equal(classify('api/templates/welcome.json', 100, { themes }).category, 'data');
  assert.deepEqual(classify('api/templates/page.liquid', 100, { themes }), { category: 'other', lang: null });
  assert.deepEqual(classify('templates/product.json', 100), { category: 'data', lang: null });
});

test('Liquid tags, asset_url and {% liquid %} lines connect files by name; comments are skipped', () => {
  assert.ok(linked('layout/theme.liquid', 'sections/header-group.json'));
  assert.ok(linked('layout/theme.liquid', 'assets/theme.js'));
  assert.ok(linked('layout/theme.liquid', 'assets/theme.css.liquid'), "'theme.css' | asset_url is served from theme.css.liquid");
  assert.ok(linked('sections/header.liquid', 'snippets/logo.liquid'), 'a render whose name is on the next line');
  assert.ok(linked('sections/main-product.liquid', 'snippets/price.liquid'));
  assert.ok(linked('templates/customers/account.liquid', 'snippets/price.liquid'));
  assert.ok(!scan.edges.some((e) => e.to.includes('old-badge')));
  assert.ok(!linked('snippets/badge.liquid', 'snippets/logo.liquid'), "a {% doc %} @example isn't a real render");
});

test("Liquid typed into a JSON template's custom-liquid setting counts; commented-out renders there don't", () => {
  assert.ok(linked('templates/index.json', 'snippets/signup.liquid'));
  assert.ok(!linked('templates/index.json', 'snippets/logo.liquid'));
});

test('JSON templates and section groups use their sections and theme blocks, not schema-only blocks', () => {
  assert.ok(linked('sections/header-group.json', 'sections/header.liquid'));
  assert.ok(linked('templates/product.json', 'sections/main-product.liquid'));
  assert.ok(linked('templates/product.json', 'blocks/review-stars.liquid'));
  assert.ok(!scan.edges.some((e) => e.from.endsWith('templates/product.json') && e.to.endsWith('snippets/price.liquid')), 'a block type is not a snippet');
});

test('apps used in templates and app embeds are external packages', () => {
  const apps = Object.fromEntries(scan.externals.filter((e) => e.eco === 'shopify-app').map((e) => [e.name, e.files]));
  assert.deepEqual(apps, { 'product-reviews': 1, 'loyalty-rewards': 1 });
});

test('a theme with nothing missing has no unresolved references (Shopify-supplied _blocks included)', () => {
  const out = run('scan.mjs', root);
  assert.match(out, /resolved, 0 unresolved/);
});

test('templates are storefront screens, alternate templates opened with ?view=; non-theme templates are not', () => {
  const urls = graph.screens.map((s) => s.url).sort();
  assert.deepEqual(urls, ['/', '/account', '/collections/:handle?view=sale', '/products/:handle']);
  assert.ok(graph.screens.every((s) => s.file.startsWith('storefront/')));
});

test("a snippet's doc comment and parameters, a section's schema name and blocks", () => {
  const read = (p) => extract(fs.readFileSync(path.join(root, p), 'utf8'), 'liquid', p);
  const price = read('storefront/snippets/price.liquid');
  assert.equal(price.doc, "Renders a product's price, with the sale price when there is one.");
  assert.deepEqual(price.symbols.map((s) => `${s.kind}:${s.name}`), ['param:product']);
  const badge = read('storefront/snippets/badge.liquid');
  assert.equal(badge.doc, 'Renders a small label over a product card.');
  assert.deepEqual(badge.symbols.map((s) => `${s.kind}:${s.name}`), ['param:label']);
  const header = read('storefront/sections/header.liquid');
  assert.deepEqual(header.symbols.map((s) => `${s.kind}:${s.name}`), ['section:Header', 'block:menu']);
});

test('only real requests count: fetch() yes, page links and SVG namespaces no', () => {
  const p = 'storefront/sections/main-product.liquid';
  const r = extract(fs.readFileSync(path.join(root, p), 'utf8'), 'liquid', p);
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), ['POST /apps/loyalty/points']);
  assert.deepEqual(r.hosts, []);
});

test('a snippet nothing renders is flagged unused; templates and sections never are', () => {
  const text = JSON.stringify(graph.health.issues.filter((i) => i.kind === 'unused-file'));
  assert.match(text, /storefront\/snippets\/unused-badge\.liquid/);
  assert.doesNotMatch(text, /templates\/|sections\//);
});
