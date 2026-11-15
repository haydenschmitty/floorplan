// Nuxt auto-imports: pages use components and composables with no import line. The scan links them by name,
// from the lists Nuxt writes to .nuxt/components.d.ts and .nuxt/imports.d.ts when they're there, and from
// Nuxt's folder conventions when they aren't. .nuxt/ itself never becomes part of the map.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, makeProject, run, scanAndBuild, readGraph, readJson, cleanup } from './helpers.mjs';

const { componentName } = await lib('nuxt.mjs');

/** A small Nuxt 4 app (source under app/), optionally with the lists Nuxt writes to .nuxt/. */
function nuxtApp({ generated = false } = {}) {
  const files = {
    'package.json': JSON.stringify({ name: 'teams', dependencies: { nuxt: '^4.0.0', 'cart-kit': '^1.0.0' } }),
    'nuxt.config.ts': `export default defineNuxtConfig({ devtools: { enabled: true } })\n`,
    'app/app.vue': `<template>\n  <NuxtLayout><NuxtPage /></NuxtLayout>\n</template>\n`,
    'app/pages/index.vue': [
      `<template>`,
      `  <main>`,
      `    <h1>{{ title }}</h1>`,
      `    <WorkspaceTeam :projects="projects" />`,
      `    <lazy-user-avatar v-if="me" />`,
      `    <TeamCard />`,
      `    <NuxtLink to="/settings">Settings</NuxtLink>`,
      `    <!-- <BaseButton /> is commented out -->`,
      `    <p>{{ formatDate(updated) }}</p>`,
      `  </main>`,
      `</template>`,
      `<script setup lang="ts">`,
      `const { projects, title, updated } = useProjects()`,
      `const me = useState('me')`,
      `</script>`,
    ].join('\n'),
    'app/pages/settings.vue': [
      `<template>`,
      `  <BaseButton @click="save">Save</BaseButton>`,
      `  <workspace-team />`,
      `</template>`,
      `<script setup lang="ts">`,
      `// useCart here is the package's, and useProjects is this file's own: neither is an auto-import`,
      `import { useCart } from 'cart-kit'`,
      `function useProjects() { return [] }`,
      `const cart = useCart()`,
      `const list = useProjects()`,
      `function save() {}`,
      `</script>`,
    ].join('\n'),
    'app/components/workspace/Team.vue': `<template><ul><li v-for="p in projects">{{ p.name }}</li></ul></template>\n<script setup lang="ts">\ndefineProps<{ projects: { name: string }[] }>()\n</script>\n`,
    'app/components/UserAvatar.vue': `<template><img :src="avatarUrl()" /></template>\n`,
    'app/components/base/BaseButton.vue': `<template><button><slot /></button></template>\n`,
    'app/composables/useProjects.ts': `export function useProjects() {\n  return useFetch('/api/projects')\n}\n`,
    'app/composables/useCart.ts': `export const useCart = () => ({ items: [] })\n`,
    'app/utils/format.ts': `export function formatDate(d: Date) {\n  return d.toISOString()\n}\nexport const avatarUrl = () => '/me.png'\n`,
    // server code gets Nitro's own auto-imports, not the app's
    'server/api/projects.ts': `export default defineEventHandler(() => useProjects())\n`,
    // .nuxt/ holds Nuxt's build output: never part of the map, however much is in there
    '.nuxt/app.config.mjs': `export default {}\n`,
    '.nuxt/nuxt.d.ts': `/// <reference path="./components.d.ts" />\n`,
  };
  if (generated) {
    // Nuxt's own lists, as an app configured with a component named TeamCard (pathPrefix: false) would have
    files['.nuxt/components.d.ts'] = [
      `import type { DefineComponent, SlotsType } from 'vue'`,
      `interface _GlobalComponents {`,
      `  'TeamCard': typeof import("../app/components/workspace/Team.vue")['default']`,
      `  'UserAvatar': typeof import("../app/components/UserAvatar.vue")['default']`,
      `  'BaseButton': typeof import("../app/components/base/BaseButton.vue")['default']`,
      `  'NuxtLink': typeof import("../node_modules/nuxt/dist/app/components/nuxt-link")['default']`,
      `  'LazyTeamCard': LazyComponent<typeof import("../app/components/workspace/Team.vue")['default']>`,
      `  'LazyUserAvatar': LazyComponent<typeof import("../app/components/UserAvatar.vue")['default']>`,
      `}`,
      `export const TeamCard: typeof import("../app/components/workspace/Team.vue")['default']`,
    ].join('\n');
    files['.nuxt/imports.d.ts'] = [
      `export { useState, useFetch } from '../node_modules/nuxt/dist/app/composables';`,
      `export { useProjects } from '../app/composables/useProjects';`,
      `export { useCart } from '../app/composables/useCart';`,
      `export { formatDate, avatarUrl } from '../app/utils/format';`,
    ].join('\n');
  }
  return makeProject(files, { arch: { project: { name: 'Teams', summary: 'A sample Nuxt app.' }, nodes: [{ id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['app/**', 'nuxt.config.ts'] }, { id: 'api', label: 'Server', kind: 'service', summary: 'The server.', paths: ['server/**'] }] } });
}

const scanOf = (root) => readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
const linksFrom = (scan, from) => scan.edges.filter((e) => e.from === from).map((e) => `${e.to} ${(e.names || []).join(',')}`).sort();

test('Nuxt components are named the way Nuxt names them', () => {
  assert.equal(componentName('workspace/Team.vue'), 'WorkspaceTeam');
  assert.equal(componentName('base/BaseButton.vue'), 'BaseButton');
  assert.equal(componentName('UserAvatar.vue'), 'UserAvatar');
  assert.equal(componentName('form/index.vue'), 'Form');
  assert.equal(componentName('app-header/nav-menu.client.vue'), 'AppHeaderNavMenu');
  assert.equal(componentName('base/foo/Button.vue'), 'BaseFooButton');
});

test('with .nuxt/ lists: pages link to the components and composables they use, by Nuxt’s own names', () => {
  const root = nuxtApp({ generated: true });
  try {
    const summary = run('scan.mjs', root);
    const scan = scanOf(root);
    assert.deepEqual(linksFrom(scan, 'app/pages/index.vue'), [
      'app/components/UserAvatar.vue UserAvatar',
      'app/components/workspace/Team.vue TeamCard',
      'app/composables/useProjects.ts useProjects',
      'app/utils/format.ts formatDate',
    ]);
    // in the lists, WorkspaceTeam isn't a name (this app calls it TeamCard), so <workspace-team> links nowhere
    assert.deepEqual(linksFrom(scan, 'app/pages/settings.vue'), ['app/components/base/BaseButton.vue BaseButton']);
    assert.deepEqual(linksFrom(scan, 'app/components/UserAvatar.vue'), ['app/utils/format.ts avatarUrl']);
    assert.deepEqual(linksFrom(scan, 'server/api/projects.ts'), []);
    assert.match(summary, /NUXT {2}\.: 3 file\(s\) linked .* from \.nuxt\/components\.d\.ts and \.nuxt\/imports\.d\.ts/);
    assert.ok(!scan.files.some((f) => f.path.includes('.nuxt')), 'nothing in .nuxt/ is on the map');
  } finally { cleanup(root); }
});

test('without .nuxt/ lists: Nuxt’s folder conventions, with folder prefixes and Lazy', () => {
  const root = nuxtApp();
  try {
    const summary = run('scan.mjs', root);
    const scan = scanOf(root);
    assert.deepEqual(linksFrom(scan, 'app/pages/index.vue'), [
      'app/components/UserAvatar.vue UserAvatar',
      'app/components/workspace/Team.vue WorkspaceTeam',
      'app/composables/useProjects.ts useProjects',
      'app/utils/format.ts formatDate',
    ]);
    // a name the file imports from a package, or defines itself, isn't the auto-import of the same name
    assert.deepEqual(linksFrom(scan, 'app/pages/settings.vue'), ['app/components/base/BaseButton.vue BaseButton', 'app/components/workspace/Team.vue WorkspaceTeam']);
    assert.deepEqual(linksFrom(scan, 'server/api/projects.ts'), []);
    assert.match(summary, /NUXT {2}\.: 3 file\(s\) linked .* from Nuxt's folder conventions/);
    assert.ok(!scan.files.some((f) => f.path.includes('.nuxt')), 'nothing in .nuxt/ is on the map');
  } finally { cleanup(root); }
});

test('the links reach the map and its Screens, and a project without Nuxt gets none', () => {
  const root = nuxtApp({ generated: true });
  try {
    scanAndBuild(root);
    const graph = readGraph(root);
    assert.ok(graph.links.some((l) => l.a === 'f:app/pages/index.vue' && l.b === 'f:app/components/workspace/Team.vue'), 'page → component on the map');
    const home = graph.screens.find((s) => s.url === '/');
    assert.ok(home, 'the home screen');
    const behind = home.behind.map((b) => b.id);
    assert.ok(behind.includes('f:app/components/workspace/Team.vue'), behind.join(', '));
    assert.ok(behind.includes('f:app/composables/useProjects.ts'), behind.join(', '));
    assert.ok(!graph.files.some((f) => f.p.includes('.nuxt')));
  } finally { cleanup(root); }
  // the same files without a nuxt.config are plain Vue: no name matching
  const plain = makeProject({
    'src/pages/index.vue': `<template><WorkspaceTeam /></template>\n<script setup>\nconst p = useProjects()\n</script>\n`,
    'src/components/workspace/Team.vue': `<template><div /></template>\n`,
    'src/composables/useProjects.js': `export function useProjects() {}\n`,
  });
  try {
    const summary = run('scan.mjs', plain);
    assert.deepEqual(scanOf(plain).edges, []);
    assert.doesNotMatch(summary, /NUXT/);
  } finally { cleanup(plain); }
});

test('an app whose name lists are unreadable or huge falls back to the conventions', () => {
  const root = nuxtApp();
  try {
    fs.mkdirSync(path.join(root, '.nuxt', 'components.d.ts'), { recursive: true }); // a folder, not a file
    const scan = (run('scan.mjs', root), scanOf(root));
    assert.ok(linksFrom(scan, 'app/pages/index.vue').includes('app/components/workspace/Team.vue WorkspaceTeam'));
  } finally { cleanup(root); }
});
