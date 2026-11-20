// Floorplan is also a Pi package. These checks keep the package manifest, project-local
// extension, and portable skill connected without requiring Pi to be installed in the test runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const require = createRequire(import.meta.url);

function loadExtension(pi) {
  const extensionPath = path.join(root, '.pi/extensions/floorplan.ts');
  const source = read('.pi/extensions/floorplan.ts')
    .replace('import { dirname, join } from "node:path";', 'const { dirname, join } = require("node:path");')
    .replace('import { fileURLToPath } from "node:url";', 'const { fileURLToPath } = require("node:url");')
    .replace(/import type .*?;\n/, '')
    .replace('pi: ExtensionAPI', 'pi')
    .replace('args: string', 'args')
    .replace('fileURLToPath(import.meta.url)', `fileURLToPath(${JSON.stringify(pathToFileURL(extensionPath).href)})`)
    .replace('export default function', 'return function');
  return new Function('require', source)(require)(pi);
}

test('Pi package declares the Floorplan extension and skill', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.pi, {
    extensions: ['./.pi/extensions/floorplan.ts'],
    skills: ['./skills'],
  });
  assert.ok(pkg.keywords.includes('pi-package'));
});

test('Pi extension exposes the bundled skill and dispatches /floorplan', async () => {
  const events = new Map();
  const commands = new Map();
  const messages = [];
  loadExtension({
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, options) { commands.set(name, options); },
    async sendUserMessage(content, options) { messages.push({ content, options }); },
  });

  const resources = events.get('resources_discover')();
  assert.deepEqual(resources.skillPaths, [path.join(root, 'skills/floorplan')]);
  assert.equal(commands.get('floorplan').description, 'Create or refresh a Floorplan map of the current project');

  await commands.get('floorplan').handler('src --refresh');
  assert.deepEqual(messages, [{
    content: '/skill:floorplan src --refresh',
    options: { expandPromptTemplates: true },
  }]);
});

test('Floorplan skill gives Pi agents a path-independent invocation rule', () => {
  const skill = read('skills/floorplan/SKILL.md');
  assert.match(skill, /\*\*In Pi:\*\*/);
  assert.match(skill, /Pi supplies this skill's directory/);
});
