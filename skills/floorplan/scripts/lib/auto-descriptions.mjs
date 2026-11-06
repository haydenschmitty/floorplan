// Scan-derived placeholders for --lite. These are not verified explanations.
import path from 'node:path';
const first = (s) => String(s || '').trim().split(/\r?\n/).map((line) => line.replace(/^\s*\*\s?/, '').trim()).find(Boolean);
const concise = (s) => s && s.length > 180 ? s.slice(0, 177).trimEnd() + '…' : s;
export function autoFileDescription(f) {
  const doc = first(f.doc);
  if (doc) return concise(doc);
  const symbol = (f.symbols || []).find((s) => s.name && !s.name.startsWith('_'));
  if (symbol) return concise(`Defines ${symbol.name} (${symbol.kind || 'code'}) in ${path.posix.basename(f.path)}.`);
  return `Contains ${f.lang || f.category || 'project'} code in ${path.posix.basename(f.path)}.`;
}
export function autoRouteDescription(r) {
  const doc = first(r.doc);
  return doc ? concise(doc) : `Handles ${r.method} ${r.path}.`;
}
