// Supabase Edge Functions: each folder under supabase/functions/ is one function, served at
// /functions/v1/<folder name>. Its index file answers every request to that address (Deno.serve, or serve()
// from Deno's standard library), so it's one endpoint for any method. When the function runs a router of its
// own (Hono, Oak…), Supabase hands it the address from /<folder name> on, and the router's endpoints are put
// under /functions/v1 instead. Folders starting with _ (_shared) hold code the functions share, not functions.
//
// The website calls a function by name, supabase.functions.invoke('send-invite'), which extract.mjs reads
// as a request to /functions/v1/send-invite, or by its address.

const FUNCTION_FILE = /^((?:.*\/)?supabase\/functions)\/([A-Za-z0-9][\w-]*)\/index\.(?:ts|js|mts|mjs|tsx|jsx)$/;
const SERVES = /\bDeno\.serve\s*(?:<[^;()]{0,200}?>\s*)?\(|(?<![\w$.])serve\s*\(|^[ \t]*export\s+default\s*\{[^}]{0,300}?\bfetch\b/m;
export const EDGE_PREFIX = '/functions/v1';

/** The function a file is the entry of: { dir, name } for supabase/functions/<name>/index.ts, else null. */
export function edgeFunctionOf(p) {
  const m = FUNCTION_FILE.exec(p);
  return m ? { dir: `${m[1]}/${m[2]}`, name: m[2] } : null;
}

/**
 * Puts each Edge Function's endpoints on the map. Routes a function's own router declares (in `routes`, from
 * resolveRoutes) are moved under /functions/v1 in place; a function without any gets one endpoint for any method.
 * @param files scan files ({ path })
 * @param routes the scan's routes ({ file, method, path, line }), changed in place and added to
 * @param read  (path) => file text, '' when it can't be read
 * @returns { functions: [{ name, file, routes }] }
 */
export function edgeFunctionRoutes(files, routes, read) {
  const functions = [];
  for (const f of files) {
    const fn = edgeFunctionOf(f.path);
    if (!fn || f.tooLarge) continue;
    const inDir = (p) => p.startsWith(fn.dir + '/');
    const own = routes.filter((r) => inDir(r.file));
    if (own.length) {
      // the router sees the address from the function's name on: app.post('/send-invite/resend') is
      // /functions/v1/send-invite/resend. A route that doesn't start with the name can't be reached that way.
      for (const r of own) if (r.path === `/${fn.name}` || r.path.startsWith(`/${fn.name}/`)) r.path = EDGE_PREFIX + r.path;
      functions.push({ name: fn.name, file: f.path, routes: own.length });
      continue;
    }
    const src = read(f.path);
    const serve = SERVES.exec(src);
    if (!serve) continue;
    const line = src.slice(0, serve.index).split('\n').length;
    routes.push({ file: f.path, method: 'ANY', path: `${EDGE_PREFIX}/${fn.name}`, line, handler: null, framework: 'supabase-edge' });
    functions.push({ name: fn.name, file: f.path, routes: 1 });
  }
  return { functions };
}
