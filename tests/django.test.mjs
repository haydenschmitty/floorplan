// Django: an app's urls.py included under a prefix by the project's urls.py.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { makeProject, run, readJson, cleanup } from './helpers.mjs';

const root = makeProject({
  'manage.py': '',
  'mysite/__init__.py': '',
  'mysite/urls.py': [
    'from django.urls import include, path, re_path',
    'urlpatterns = [',
    '    path("api/orders/", include("orders.urls")),',
    '    re_path(r"^api/shop/", include(("shop.urls", "shop"), namespace="shop")),',
    ']',
  ].join('\n'),
  'orders/__init__.py': '',
  'orders/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [\n    path("", views.order_list),\n    path("<int:pk>/", views.order_detail),\n]\n',
  'orders/views.py': 'def order_list(request): ...\ndef order_detail(request, pk): ...\n',
  'shop/__init__.py': '',
  'shop/urls.py': 'from django.urls import path\nfrom . import views\nurlpatterns = [path("cart/", views.cart)]\n',
  'shop/views.py': 'def cart(request): ...\n',
  'web/api.js': 'export const getOrder = (id) => fetch(`/api/orders/${id}/`);\n',
});
after(() => cleanup(root));

test('urls included under a prefix get it, and the include line is not an endpoint itself', () => {
  run('scan.mjs', root);
  const scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  assert.deepEqual(scan.routes.map((r) => `${r.file} ${r.path}`).sort(), [
    'orders/urls.py /api/orders',
    'orders/urls.py /api/orders/<int:pk>',
    'shop/urls.py /api/shop/cart',
  ]);
  assert.ok(scan.edges.some((e) => e.from === 'mysite/urls.py' && e.to === 'orders/urls.py'), 'expected the project urls to use the app urls');
  assert.deepEqual(scan.http.map((h) => `${h.from} -> ${h.path}`), ['web/api.js -> /api/orders/<int:pk>']);
});
