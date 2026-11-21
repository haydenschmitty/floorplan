// Regression test for issue #149: an edge between two external nodes used to show "Layout failed"
// in the overview. layout() set 'elk.layered.layering.layerConstraint': 'LAST' on every external
// node unconditionally. ELK rejects an edge between two LAST-constrained nodes with
// UnsupportedConfigurationException. The fix: pin an external node to LAST only when all of its
// outgoing edges (if any) go to LAST_SEPARATE connector nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { REPO } from './helpers.mjs';

const req = createRequire(import.meta.url);
const ELK = req(path.join(REPO, 'skills/floorplan/assets/vendor/elk.bundled.js'));

/** Extracts the async layout() function from the viewer source. */
function layoutFnSource() {
  const html = fs.readFileSync(path.join(REPO, 'skills/floorplan/assets/viewer.html'), 'utf8');
  const start = html.indexOf('\nasync function layout(view) {');
  assert.ok(start > 0, 'layout() found in viewer.html');
  const end = html.indexOf('\n}\n', start) + 3;
  return html.slice(start, end);
}

/**
 * Runs layout() from the viewer source against `view`, using the provided elk implementation
 * and minimal mocks for all other globals the function needs.
 */
async function runLayout(view, { elk, nodesMap } = {}) {
  const nodes = nodesMap ?? new Map([
    ['ext-a', { id: 'ext-a', label: 'Service A', kind: 'external' }],
    ['ext-b', { id: 'ext-b', label: 'Service B', kind: 'external' }],
  ]);
  // The layout() function runs in a VM context whose Array/Object constructors differ from the
  // host's. ELK's Java bridge checks Array.isArray() on the host side, so it treats VM-context
  // arrays as empty. JSON round-trip converts them to plain host-context objects before ELK sees them.
  const realElk = new ELK();
  const ctx = {
    elk: elk ?? { layout: (input) => realElk.layout(JSON.parse(JSON.stringify(input))) },
    nodes,
    info: (item) => {
      if (item.startsWith('n:')) {
        const n = nodes.get(item.slice(2));
        return { type: 'node', name: n?.label ?? item, n };
      }
      return { type: 'file', name: item };
    },
    cardExtraH: () => 0,
    answerNote: () => false,
    clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
    textW: () => 100,
    SIZES: { node: [300, 128], dir: [272, 110], file: [284, 110], module: [284, 110], route: [300, 128], symbol: [260, 100] },
    NOTE_H: 64,
  };
  vm.runInNewContext(layoutFnSource(), ctx);
  return ctx.layout(view);
}

/** Returns a mock elk whose layout() captures its input and resolves immediately. */
function captureElk() {
  let captured;
  const mock = {
    layout: (input) => {
      captured = input;
      return Promise.resolve({ id: 'g', children: input.children.map((c) => ({ ...c, x: 0, y: 0 })), edges: [] });
    },
  };
  return { mock, get captured() { return captured; } };
}

test('an edge between two external nodes does not make layout() throw (issue #149)', async () => {
  // Before the fix both n:ext-a and n:ext-b get layerConstraint LAST, and ELK rejects the
  // edge between them with UnsupportedConfigurationException.
  await assert.doesNotReject(
    runLayout({
      visible: ['n:ext-a', 'n:ext-b'],
      connectors: [],
      edges: [{ id: 'e0', a: 'n:ext-a', b: 'n:ext-b' }],
    }),
  );
});

test('a lone external node with no outgoing edges is still pinned to the last layer', async () => {
  const ce = captureElk();
  const nodesMap = new Map([['ext-sink', { id: 'ext-sink', label: 'Stripe', kind: 'external' }]]);
  await runLayout({ visible: ['n:ext-sink'], connectors: [], edges: [] }, { elk: ce.mock, nodesMap });
  const child = ce.captured.children.find((c) => c.id === 'n:ext-sink');
  assert.equal(
    child?.layoutOptions?.['elk.layered.layering.layerConstraint'], 'LAST',
    'a sole external node with no outgoing edges should still be pinned to LAST',
  );
});

test('the downstream external node in an ext→ext edge is still pinned to the last layer', async () => {
  // ext-a (source) must NOT get LAST; ext-b (sink) must still get LAST.
  const ce = captureElk();
  await runLayout(
    { visible: ['n:ext-a', 'n:ext-b'], connectors: [], edges: [{ id: 'e0', a: 'n:ext-a', b: 'n:ext-b' }] },
    { elk: ce.mock },
  );
  const a = ce.captured.children.find((c) => c.id === 'n:ext-a');
  const b = ce.captured.children.find((c) => c.id === 'n:ext-b');
  assert.equal(a?.layoutOptions?.['elk.layered.layering.layerConstraint'], undefined, 'source ext should not be LAST');
  assert.equal(b?.layoutOptions?.['elk.layered.layering.layerConstraint'], 'LAST', 'sink ext should still be LAST');
});
