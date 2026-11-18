// Go router groups: a route on a group keeps the group's prefix (Gin, Echo, Fiber and chi's
// `Group`), chi's inline subrouter (`r.Route("/api", func(r chi.Router) { … })`, also
// `r.With(auth).Route(…)` and one Route inside another) prefixes the routes inside it, and Go
// 1.22's `mux.HandleFunc("GET /orders/{id}", …)` reads its method from the pattern. Routes beside
// a group, and on a router the callback doesn't hand over, keep no prefix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { lib, makeProject, run, readGraph, routeKeys, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');

const go = (body) => extract([
  `package main`,
  `import ("net/http"; "github.com/go-chi/chi/v5")`,
  `func main() {`,
  ...body,
  `  http.ListenAndServe(":3000", r)`,
  `}`,
].join('\n'), 'go', 'cmd/main.go');
const routesOf = (r) => r.routes.map((x) => `${x.method} ${x.path}`).sort();

test('chi Route: the routes inside it sit under its prefix', () => {
  const r = go([
    `  r := chi.NewRouter()`,
    `  r.Route("/api", func(r chi.Router) {`,
    `    r.Get("/orders", listOrders)`,
    `    r.Post("/orders", createOrder)`,
    `  })`,
  ]);
  assert.deepEqual(routesOf(r), ['GET /api/orders', 'POST /api/orders']);
});

test('chi Route: one Route inside another composes, and a route beside it keeps no prefix', () => {
  const r = go([
    `  r := chi.NewRouter()`,
    `  r.Get("/top", top)`,
    `  r.Route("/api", func(r chi.Router) {`,
    `    r.Route("/v1", func(r chi.Router) {`,
    `      r.Get("/orders", listOrders)`,
    `    })`,
    `    r.Get("/health", health)`,
    `  })`,
    `  r.Get("/after", after)`,
  ]);
  assert.deepEqual(routesOf(r), ['GET /after', 'GET /api/health', 'GET /api/v1/orders', 'GET /top']);
});

test('chi Route: a check in front of it (With) and a Route on a group variable', () => {
  const r = go([
    `  r := chi.NewRouter()`,
    `  r.With(requireAuth).Route("/admin", func(r chi.Router) {`,
    `    r.Get("/users", listUsers)`,
    `  })`,
    `  api := r.Group("/api")`,
    `  api.Route("/v1", func(r chi.Router) {`,
    `    r.Get("/orders", listOrders)`,
    `  })`,
    `  api.Get("/health", health)`,
  ]);
  // the Route's prefix is written into the path; the group's reaches its routes through the
  // variable, when the map is built
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path} :${x.var}`), ['GET /admin/users :null', 'GET /v1/orders :api', 'GET /health :api']);
  assert.equal(r.routers.api, '/api');
});

test('a group made inside a Route callback sits under the callback too', () => {
  const r = go([
    `  r := chi.NewRouter()`,
    `  r.Route("/api", func(r chi.Router) {`,
    `    v1 := r.Group("/v1")`,
    `    v1.Get("/orders", listOrders)`,
    `    r.Get("/health", health)`,
    `  })`,
  ]);
  assert.equal(r.routers.v1, '/api/v1');
  // the group's prefix reaches the route through its variable, when the map is built
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path} :${x.var}`), ['GET /orders :v1', 'GET /api/health :null']);
});

test('a route on another router inside a Route callback gets no prefix from it', () => {
  const r = go([
    `  r := chi.NewRouter()`,
    `  r.Route("/api", func(r chi.Router) {`,
    `    other.Get("/elsewhere", elsewhere)`,
    `    r.Get("/orders", listOrders)`,
    `  })`,
  ]);
  assert.deepEqual(routesOf(r), ['GET /api/orders', 'GET /elsewhere']);
});

test('Gin, Echo and Fiber groups: nested groups compose', () => {
  const gin = extract([
    `package main`,
    `import "github.com/gin-gonic/gin"`,
    `func main() {`,
    `  r := gin.Default()`,
    `  api := r.Group("/api")`,
    `  api.GET("/orders", listOrders)`,
    `  v1 := api.Group("/v1")`,
    `  v1.POST("/orders", createOrder)`,
    `  r.Run()`,
    `}`,
  ].join('\n'), 'go', 'cmd/main.go');
  assert.deepEqual(gin.routers, { api: '/api', v1: '/api/v1' });
  assert.deepEqual(gin.routes.map((x) => `${x.method} ${x.path} :${x.var}`), ['GET /orders :api', 'POST /orders :v1']);
  const echo = extract([
    `package main`,
    `import "github.com/labstack/echo/v4"`,
    `func main() {`,
    `  e := echo.New()`,
    `  api := e.Group("/api")`,
    `  api.GET("/orders", listOrders)`,
    `  e.Start(":3000")`,
    `}`,
  ].join('\n'), 'go', 'cmd/main.go');
  assert.equal(echo.routers.api, '/api');
  assert.equal(echo.routes[0].var, 'api');
});

test('a group used inline, and routes chained on one statement, keep their prefix', () => {
  const r = extract([
    `package main`,
    `import "github.com/gin-gonic/gin"`,
    `func main() {`,
    `  r := gin.Default()`,
    `  r.Group("/api").GET("/orders", listOrders)`,
    `  r.GET("/a", a).POST("/b", b)`,
    `  r.Run()`,
    `}`,
  ].join('\n'), 'go', 'cmd/main.go');
  assert.deepEqual(routesOf(r), ['GET /a', 'GET /api/orders', 'POST /b']);
});

test('Go 1.22: the method is part of the pattern, and a plain pattern stays ANY', () => {
  const r = go([
    `  mux := http.NewServeMux()`,
    `  mux.HandleFunc("GET /orders/{id}", getOrder)`,
    `  mux.Handle("POST /orders", http.HandlerFunc(createOrder))`,
    `  mux.HandleFunc("/health", health)`,
  ]);
  assert.deepEqual(routesOf(r), ['ANY /health', 'GET /orders/{id}', 'POST /orders']);
});

test('look-alikes left alone: a group with a prefix built at run time, and Method()', () => {
  const r = go([
    `  r := chi.NewRouter()`,
    `  api := r.Group(prefix)`,
    `  api.Get("/orders", listOrders)`,
    `  r.Method("GET", "/by-method", getByMethod)`,
  ]);
  // a variable prefix can't be read, so the group isn't recorded and the route stays where it
  // is written; chi's Method takes the method as an argument rather than a call of its own,
  // so it isn't read yet
  assert.deepEqual(r.routers, {});
  assert.deepEqual(routesOf(r), ['GET /orders']);
});

let root, graph;
before(() => {
  root = makeProject({
    'go.mod': `module example.com/shop\n\ngo 1.22\n\nrequire github.com/go-chi/chi/v5 v5.0.0\n`,
    'api/main.go': [
      `package main`,
      `import ("net/http"; "github.com/go-chi/chi/v5")`,
      `func main() {`,
      `  r := chi.NewRouter()`,
      `  r.Route("/api", func(r chi.Router) {`,
      `    r.Get("/orders", listOrders)`,
      `    r.Post("/orders", createOrder)`,
      `  })`,
      `  api := r.Group("/admin")`,
      `  api.Get("/users", listUsers)`,
      `  http.ListenAndServe(":3000", r)`,
      `}`,
    ].join('\n'),
    'web/package.json': JSON.stringify({ name: 'web', type: 'module' }),
    'web/src/api.js': [
      `export const listOrders = () => fetch('/api/orders').then((r) => r.json());`,
      `export const listUsers = () => fetch('/admin/users').then((r) => r.json());`,
    ].join('\n'),
  }, {
    arch: {
      project: { name: 'Shop', summary: 'A shop with a chi API.' },
      nodes: [
        { id: 'api', label: 'Server', kind: 'service', summary: 'The chi server.', paths: ['api/**'] },
        { id: 'web', label: 'Website', kind: 'ui', summary: 'The website.', paths: ['web/**'] },
      ],
    },
  });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('end to end: grouped routes land under their prefix, and the website reaches them', () => {
  assert.deepEqual(routeKeys(graph), ['GET /admin/users', 'GET /api/orders', 'POST /api/orders']);
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${l.labels.join(', ')}`).sort();
  assert.deepEqual(http, ['web/src/api.js -> api/main.go GET /api/orders, GET /admin/users']);
});
