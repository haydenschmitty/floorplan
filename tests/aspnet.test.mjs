// ASP.NET Core: controller and minimal-API endpoints, `using` links between C# files, and a
// frontend's requests matched to the controller that answers them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lib, makeProject, run, readJson, cleanup } from './helpers.mjs';

const { extract, cleanDoc } = await lib('extract.mjs');
const routes = (src, file = 'Api/Controllers/OrdersController.cs') => extract(src, 'csharp', file).routes.map((r) => `${r.method} ${r.path}`);

const CONTROLLER = [
  'using Microsoft.AspNetCore.Mvc;',
  'using Shop.Domain.Orders;',
  '',
  'namespace Shop.Api.Controllers;',
  '',
  '/// <summary>',
  '/// Orders placed by signed-in customers.',
  '/// </summary>',
  '[ApiController]',
  '[Route("api/[controller]")]',
  '// a comment between the attributes and the class',
  'public sealed class OrdersController(IOrderService orders) : ControllerBase',
  '{',
  '    /// <summary>Lists the customer\'s <see cref="Shop.Domain.Orders.Order"/>s, newest first.</summary>',
  '    [HttpGet]',
  '    public async Task<ActionResult<IReadOnlyList<Order>>> ListAsync() => Ok(await orders.ListAsync());',
  '',
  '    [HttpGet("{id:guid}")]',
  '    [EndpointDescription(',
  '        "Spans two lines.")]',
  '    public IActionResult Get(Guid id, [FromQuery] bool full) => Ok(items[0]);',
  '',
  '    [HttpPost("{id:guid}/refund"), Authorize(Policy = "Refunds")]',
  '    public IActionResult Refund(Guid id, RefundRequest body) => Ok();',
  '',
  '    [Route("[action]")]',
  '    [HttpPut]',
  '    public IActionResult Archive() => Ok();',
  '',
  '    [HttpDelete("~/admin/orders/{id}")]',
  '    public IActionResult Purge(int id) => Ok();',
  '',
  '    public sealed record RefundRequest(decimal Amount);',
  '',
  '    [HttpGet("after-a-nested-record")]',
  '    public IActionResult Later() => Ok();',
  '}',
].join('\n');

test('ASP.NET Core controllers: [Route] prefix, tokens, verb templates and absolute paths', () => {
  assert.deepEqual(routes(CONTROLLER), [
    'GET /api/Orders',
    'GET /api/Orders/{id:guid}',
    'POST /api/Orders/{id:guid}/refund',
    'PUT /api/Orders/Archive',
    'DELETE /admin/orders/{id}',
    'GET /api/Orders/after-a-nested-record',
  ]);
});

test('ASP.NET Core controllers: actions are named, XML doc summaries become descriptions', () => {
  const r = extract(CONTROLLER, 'csharp', 'Api/Controllers/OrdersController.cs');
  assert.deepEqual(r.routes.map((x) => x.handler), ['ListAsync', 'Get', 'Refund', 'Archive', 'Purge', 'Later']);
  assert.equal(r.routes[0].doc, "Lists the customer's Orders, newest first.");
  assert.deepEqual(r.symbols.map((s) => s.name), ['OrdersController', 'RefundRequest']);
  assert.equal(cleanDoc('/// <summary>\n/// Refunds a paid order.\n/// </summary>\n/// <param name="id">The order.</param>'), 'Refunds a paid order.');
});

test('ASP.NET Core: [Area], [action] without Async, and a [Route] with no verb accepts any', () => {
  assert.deepEqual(routes([
    '[Area("Billing")]',
    '[Route("[area]/[controller]/[action]")]',
    'public class InvoicesController : Controller',
    '{',
    '    [HttpGet] public Task<IActionResult> DownloadAsync() => null;',
    '    [Route("legacy")] public IActionResult Legacy() => null;',
    '}',
  ].join('\n')), ['GET /Billing/Invoices/Download', 'ANY /Billing/Invoices/Legacy/legacy']);
});

test('ASP.NET Core: conventional routing (no templates anywhere) is left to Program.cs', () => {
  assert.deepEqual(routes('public class HomeController : Controller\n{\n    [HttpGet]\n    public IActionResult Index() => View();\n}\n'), []);
});

test('ASP.NET Core minimal APIs: MapGet and friends, under their MapGroup prefixes', () => {
  const r = extract([
    'var api = app.MapGroup("/api");',
    'var users = api.MapGroup("users");',
    'users.MapGet("/{id}", GetUser).RequireAuthorization();',
    'app.MapPost("/login", async (HttpContext c) => Results.Ok());',
    'app.MapMethods("/proxy/{**path}", ProxyEndpoint.Methods, ProxyEndpoint.Handle);',
  ].join('\n'), 'csharp', 'Api/Program.cs');
  assert.deepEqual(r.routers, { api: '/api', users: '/api/users' });
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path} ${x.var} ${x.handler ?? '-'}`), [
    'GET /{id} users GetUser',
    'POST /login app -',
    'ANY /proxy/{**path} app -',
  ]);
});

test('C#: usings, the namespaces in scope without one, and the type names a file mentions', () => {
  const r = extract(CONTROLLER, 'csharp', 'Api/Controllers/OrdersController.cs');
  assert.equal(r.pkg, 'Shop.Api.Controllers');
  assert.deepEqual(r.imports.map((i) => i.spec + (i.implicit ? ' (implicit)' : '')), [
    'Microsoft.AspNetCore.Mvc',
    'Shop.Domain.Orders',
    'Shop.Api.Controllers (implicit)',
    'Shop.Api (implicit)',
    'Shop (implicit)',
  ]);
  assert.ok(r.typeRefs.has('IOrderService'));
  assert.ok(!r.typeRefs.has('Spans'), 'words inside strings are not type references');
});

test('ASP.NET Core end to end: using links, test projects skipped, case-insensitive request matching', () => {
  const root = makeProject({
    'backend/Shop.Api/Shop.Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />\n',
    'backend/Shop.Api/Controllers/OrdersController.cs': CONTROLLER,
    'backend/Shop.Domain/Orders/IOrderService.cs': 'namespace Shop.Domain.Orders;\n\npublic interface IOrderService\n{\n    Task<IReadOnlyList<Order>> ListAsync();\n}\n',
    'backend/Shop.Domain/Orders/Order.cs': 'namespace Shop.Domain.Orders;\n\npublic sealed record Order(Guid Id);\n',
    'backend/Shop.Domain/Orders/Unused.cs': 'namespace Shop.Domain.Orders;\n\npublic sealed class Unused { }\n',
    'backend/Shop.Api.Tests/OrdersEndpointTests.cs': 'namespace Shop.Api.Tests;\n\npublic class OrdersEndpointTests\n{\n    void Configure(WebApplication app) => app.MapGet("/api/orders", () => "stub");\n}\n',
    'frontend/src/api/orders.ts': [
      "import { client } from './client';",
      "export const listOrders = () => client.GET('/api/orders');",
      "export const refund = (id: string) => client.POST(`/api/orders/${id}/refund`);",
    ].join('\n'),
    'frontend/src/api/client.ts': 'export const client = {};\n',
  }, { repos: ['backend', 'frontend'] });
  try {
    run('scan.mjs', root);
    const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
    const controller = 'backend/Shop.Api/Controllers/OrdersController.cs';
    const linked = scan.edges.filter((e) => e.from === controller).map((e) => e.to).sort();
    assert.deepEqual(linked, ['backend/Shop.Domain/Orders/IOrderService.cs', 'backend/Shop.Domain/Orders/Order.cs']);
    assert.ok(scan.externals.every((e) => !e.name.startsWith('Microsoft.AspNetCore')), 'framework namespaces are built in');
    assert.ok(scan.routes.every((r) => r.file === controller), 'the test project\'s stub endpoint is not part of the app');
    const http = scan.http.map((h) => `${h.from} ${h.method} ${h.call} -> ${h.path}`).sort();
    assert.deepEqual(http, [
      'frontend/src/api/orders.ts GET /api/orders -> /api/Orders',
      'frontend/src/api/orders.ts POST /api/orders/${x}/refund -> /api/Orders/{id:guid}/refund',
    ]);
  } finally {
    cleanup(root);
  }
});

// ---------- conventional routing, hubs, global usings ----------

const { findIssues } = await lib('health.mjs');
const { scanAndBuild, readGraph, openEndpoints } = await import('./helpers.mjs');

/** Scan (and optionally build) a project and return its scan.json. */
function scanOf(files, opts) {
  const root = makeProject(files, opts);
  try {
    run('scan.mjs', root);
    return readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  } finally {
    cleanup(root);
  }
}

test('ASP.NET Core conventional routing: plain controllers through MapControllerRoute, and only with one', () => {
  const home = [
    'namespace Web.Controllers;',
    'public class HomeController : Controller',
    '{',
    '    public HomeController(ILogger<HomeController> log) { }',
    '    public IActionResult Index() => View();',
    '    [HttpPost] public async Task<IActionResult> SaveAsync(Form f) => View();',
    '    [NonAction] public string Helper() => "";',
    '    private IActionResult Hidden() => View();',
    '}',
  ].join('\n');
  const withRoute = scanOf({
    'Web/Web.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web" />\n',
    'Web/Program.cs': 'var app = builder.Build();\napp.MapControllerRoute(name: "default", pattern: "{controller=Home}/{action=Index}/{id?}");\napp.Run();\n',
    'Web/Controllers/HomeController.cs': home,
  });
  assert.deepEqual(withRoute.routes.map((r) => `${r.method} ${r.path} ${r.handler}`), ['ANY /Home/Index/{id?} Index', 'POST /Home/Save/{id?} SaveAsync']);
  const without = scanOf({ 'Web/Web.csproj': '<Project />\n', 'Web/Controllers/HomeController.cs': home });
  assert.deepEqual(without.routes, []);
});

test('SignalR: MapHub is an endpoint, and a browser connecting with withUrl reaches it', () => {
  const scan = scanOf({
    'backend/Program.cs': 'app.MapHub<ChatHub>("/hubs/chat");\n',
    'frontend/src/chat.ts': "export const connect = (base: string) => new HubConnectionBuilder().withUrl(`${base}/hubs/chat`).build();\n",
  }, { repos: ['backend', 'frontend'] });
  assert.deepEqual(scan.routes.map((r) => `${r.method} ${r.path} ${r.handler}`), ['ANY /hubs/chat ChatHub']);
  assert.deepEqual(scan.http.map((h) => `${h.from} -> ${h.to}`), ['frontend/src/chat.ts -> backend/Program.cs']);
});

test('C# global using: the namespace is in scope across its project, not beyond it', () => {
  const scan = scanOf({
    'Api/Api.csproj': '<Project />\n',
    'Api/GlobalUsings.cs': 'global using Shop.Identity;\n',
    'Api/Orders.cs': 'namespace Shop.Api;\npublic class Orders { CurrentUser user; }\n',
    'Identity/Identity.csproj': '<Project />\n',
    'Identity/CurrentUser.cs': 'namespace Shop.Identity;\npublic sealed class CurrentUser { }\n',
    'Worker/Worker.csproj': '<Project />\n',
    'Worker/Job.cs': 'namespace Shop.Worker;\npublic class Job { CurrentUser user; }\n',
  });
  const from = (file) => scan.edges.filter((e) => e.from === file).map((e) => e.to);
  assert.deepEqual(from('Api/Orders.cs'), ['Identity/CurrentUser.cs']);
  assert.deepEqual(from('Worker/Job.cs'), [], 'another project does not see Api\'s global using');
});

// ---------- Health ----------

const health = (src, file, k) => findIssues(src, { path: file, category: 'code', lang: 'csharp', ...extract(src, 'csharp', file) }).filter((x) => x.k === k);

test('Health, ASP.NET Core: [Authorize], [AllowAnonymous], inline checks and custom auth attributes', () => {
  const src = [
    'namespace Shop.Api;',
    '[ApiController, Route("api/orders")]',
    'public class OrdersController : ControllerBase',
    '{',
    '    [HttpGet] public IActionResult List() => Ok();',
    '    [HttpPost, Authorize(Policy = "Orders.Write")] public IActionResult Create() => Ok();',
    '    [HttpGet("public"), AllowAnonymous] public IActionResult Menu() => Ok();',
    '    [HttpDelete("{id}")]',
    '    public IActionResult Delete(int id)',
    '    {',
    '        if (!User.Identity?.IsAuthenticated ?? true) return Unauthorized();',
    '        return Ok();',
    '    }',
    '    [HttpPut("{id}"), Feature("orders")] public IActionResult Update(int id) => Ok();',
    '}',
    'public sealed class FeatureAttribute : AuthorizeAttribute { public FeatureAttribute(string f) { } }',
  ].join('\n');
  const recs = health(src, 'Shop.Api/OrdersController.cs', 'route').map((r) => `${r.method} ${r.fn} ${r.public ? 'public' : r.via || 'open'}${r.guard ? ' ' + r.guard : ''}`);
  assert.deepEqual(recs, [
    'GET List open',
    'POST Create attribute [Authorize(Policy = "Orders.Write")]',
    'GET Menu public',
    'DELETE Delete inline',
    'PUT Update open',
  ]);
  assert.deepEqual(health(src, 'Shop.Api/OrdersController.cs', 'guard-def').map((g) => g.name), ['Feature']);
  assert.deepEqual(health(src, 'Shop.Api/OrdersController.cs', 'route').find((r) => r.fn === 'Update').decos, ['HttpPut', 'Feature', 'ApiController', 'Route', 'ControllerBase']);
});

test('Health, ASP.NET Core: class-level [Authorize], base controllers, minimal-API chains and app-wide policies', () => {
  const controller = '[Authorize]\n[Route("api/admin")]\npublic class AdminController : ControllerBase\n{\n    [HttpGet] public IActionResult Stats() => Ok();\n    [HttpGet("ping"), AllowAnonymous] public IActionResult Ping() => Ok();\n}\n';
  assert.deepEqual(health(controller, 'Api/AdminController.cs', 'route').map((r) => r.public ? 'public' : r.guard), ['[Authorize]', 'public']);
  const base = '[Authorize]\npublic abstract class SecureController : ControllerBase { }\n';
  assert.deepEqual(health(base, 'Api/SecureController.cs', 'guard-def').map((g) => `${g.name} ${g.base}`), ['SecureController true']);
  const minimal = 'var admin = app.MapGroup("/admin").RequireAuthorization("Admin");\nadmin.MapGet("/stats", Stats);\nadmin.MapGet("/health", Health).AllowAnonymous();\napp.MapPost("/orders", Create);\n';
  assert.deepEqual(health(minimal, 'Api/Program.cs', 'route').map((r) => r.public ? 'public' : r.guard || 'open'), ['.RequireAuthorization("Admin")', 'public', 'open']);
  const fallback = 'builder.Services.AddAuthorization(o => o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());\n';
  assert.deepEqual(health(fallback, 'Api/Program.cs', 'global-guard').map((g) => g.name), ['a fallback authorization policy']);
  assert.deepEqual(health('o.FallbackPolicy = null;\n', 'Api/Program.cs', 'global-guard'), []);
});

test('Health, ASP.NET Core end to end: an app-wide policy covers its own project only', () => {
  const root = makeProject({
    'Api/Api.csproj': '<Project />\n',
    'Api/Program.cs': 'builder.Services.AddAuthorization(o => o.FallbackPolicy = new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());\napp.MapPost("/api/orders", Create);\n',
    'Admin/Admin.csproj': '<Project />\n',
    'Admin/Program.cs': 'app.MapPost("/admin/users", CreateUser);\napp.MapDelete("/admin/users/{id}", DeleteUser).AllowAnonymous();\n',
    'Admin/RolesController.cs': '[Route("admin/roles")]\npublic class RolesController : ControllerBase\n{\n    [HttpGet, Authorize(Roles = "admin")] public IActionResult List() => Ok();\n    [HttpPost] public IActionResult Create() => Ok();\n}\n',
  }, {
    arch: {
      project: { name: 'shop', summary: 'Test.' },
      nodes: [
        { id: 'api', label: 'API', kind: 'service', summary: 'The API.', paths: ['Api/**'] },
        { id: 'admin', label: 'Admin', kind: 'service', summary: 'The admin API.', paths: ['Admin/**'] },
      ],
    },
  });
  try {
    scanAndBuild(root);
    const graph = readGraph(root);
    assert.deepEqual(openEndpoints(graph), ['POST /admin/roles', 'POST /admin/users']);
    const roles = graph.health.issues.find((i) => i.id === 'open-endpoints:Admin/RolesController.cs');
    assert.match(roles.fix, /the same check the other endpoints in this file already use \(\[Authorize\(Roles = "admin"\)\]\)/);
  } finally {
    cleanup(root);
  }
});

test('Health, C#: CORS that allows every site, Stripe webhooks without a signature, connection-string passwords', () => {
  const cors = (src) => health(src, 'Api/Program.cs', 'cors-any').map((x) => `${x.how} ${x.credentials}`);
  assert.deepEqual(cors('services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader()));'), ['AllowAnyOrigin() false']);
  assert.deepEqual(cors('p.SetIsOriginAllowed(_ => true).AllowCredentials();'), ['SetIsOriginAllowed(_ => true) true']);
  assert.deepEqual(cors('p.WithOrigins("https://shop.example.com").AllowCredentials();'), []);

  const hook = 'using Stripe;\nvar stripeEvent = EventUtility.ParseEvent(json);\nif (stripeEvent.Type == EventTypes.CheckoutSessionCompleted) Fulfil(stripeEvent);\n';
  assert.deepEqual(health(hook, 'Api/StripeWebhook.cs', 'stripe-unsigned').map((x) => x.events), [['checkout.session.completed']]);
  const signed = 'using Stripe;\nvar e = EventUtility.ConstructEvent(json, Request.Headers["Stripe-Signature"], secret);\nif (e.Type == EventTypes.InvoicePaid) Pay(e);\n';
  assert.deepEqual(health(signed, 'Api/StripeWebhook.cs', 'stripe-unsigned'), []);

  const conn = (src) => findIssues(src, { path: 'Api/appsettings.json', category: 'config', lang: 'json' }).filter((x) => x.k === 'secret').map((x) => x.what);
  assert.deepEqual(conn('{ "ConnectionStrings": { "Db": "Server=prod-sql.shop.io;Database=shop;User Id=app;Password=Tr0ub4dor&3x;" } }'), ['a database password inside a connection string']);
  assert.deepEqual(conn('{ "ConnectionStrings": { "Db": "Host=localhost;Username=app;Password=Tr0ub4dor&3x" } }'), []);
  assert.deepEqual(conn('{ "ConnectionStrings": { "Db": "Host=db.shop.io;Password=${DB_PASSWORD}" } }'), []);
});
