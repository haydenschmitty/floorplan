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
