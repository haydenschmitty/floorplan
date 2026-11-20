import { callArgs } from './common.mjs';

const ID = '[A-Za-z_$][\\w$]*';
const esc = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const NEXT_CATCH_ALL = /^(.*)\/\[\[?\.\.\.([\w$]+)\]\]?$/;

function baseURL(arg) {
  const property = /^\{\s*baseURL\s*:\s*(process\.env\.[\w$]+|(["'`])(?:\$\{[\w$]+\})?(\/[\w./~-]*)\2)\s*[,}]/.exec(arg);
  if (!property) return null;
  return property[3] ? { path: property[3].replace(/\/$/, '') } : { env: true };
}

// Read the Axios factory and the catch-all's forwarding expression from comment-free JS.
// Keep these hints within the scan, without reading the values of environment variables.
export function nextProxyHints(code, imports, file) {
  const axios = imports.find((item) => item.spec === 'axios');
  const local = Object.keys(axios?.locals || {}).find((name) => axios.locals[name] === 'default');
  const clients = new Map(), envConfigs = new Set();
  if (local) {
    const create = new RegExp(`\\bconst\\s+(${ID})\\s*=\\s*${esc(local)}\\.create\\s*\\(`, 'g');
    for (const match of code.matchAll(create)) {
      const arg = callArgs(code, match.index + match[0].length)?.[0]?.trim();
      if (!arg) continue;
      const base = baseURL(arg);
      if (base) clients.set(match[1], base);
      else if (/^[A-Za-z_$][\w$]*$/.test(arg)) clients.set(match[1], { config: arg });
    }
  }
  if (code.includes('baseURL')) {
    const config = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?=\{\s*baseURL\s*:)/g;
    for (const match of code.matchAll(config)) {
      if (baseURL(code.slice(match.index + match[0].length, match.index + match[0].length + 300))?.env) envConfigs.add(match[1]);
    }
  }
  const route = /(?:^|\/)pages\/(api\/.+)\.[jt]sx?$/.exec(file);
  const proxy = route && NEXT_CATCH_ALL.exec('/' + route[1]);
  const forwarding = proxy ? forwardedClient(code, proxy[2]) : null;
  return {
    ...(clients.size ? { axiosClients: clients } : {}),
    ...(envConfigs.size ? { axiosEnvConfigs: envConfigs } : {}),
    ...(forwarding ? { nextProxy: { prefix: proxy[1], client: forwarding } } : {}),
  };
}

function forwardedClient(code, param) {
  const queries = /\bconst\s*\{([^{}]{1,250})\}\s*=\s*([\w$]+)\.query\b/g;
  const binding = new RegExp(`^${esc(param)}(?:\\s*:\\s*(${ID}))?$`);
  for (const [, fields, req] of code.matchAll(queries)) {
    const field = fields.split(',').map((name) => binding.exec(name.trim())).find(Boolean);
    if (!field) continue;
    const part = esc(field[1] || param);
    const join = new RegExp(`\\b(${ID})\\s*=\\s*${part}\\s*(?:\\.filter\\(\\s*Boolean\\s*\\)\\s*)?\\.join\\(\\s*['"]/['"]\\s*\\)`);
    const url = join.exec(code)?.[1];
    if (!url) continue;
    const call = new RegExp(`(?<![\\w$.])(${ID})\\s*\\(\\s*\\{\\s*method\\s*:\\s*${esc(req)}\\.method\\s*,\\s*url\\s*:\\s*${esc(url)}\\s*[,}]`);
    const client = call.exec(code)?.[1];
    if (client) return client;
  }
  return null;
}
