// Django: an app's urls.py included under a prefix by the project's urls.py, and imports between apps.
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

test('absolute imports between apps reach the other app, not the importing app\'s own apps.py (#99)', () => {
  const p = 'backend/web_app/';
  const root2 = makeProject({
    [p + 'manage.py']: '',
    [p + 'apps/__init__.py']: '',
    [p + 'apps/core/__init__.py']: '',
    [p + 'apps/core/apps.py']: 'from django.apps import AppConfig\nclass CoreConfig(AppConfig): name = "apps.core"\n',
    [p + 'apps/core/utils.py']: 'def front_url(path): return path\n',
    [p + 'apps/orders/__init__.py']: '',
    [p + 'apps/orders/apps.py']: 'from django.apps import AppConfig\nclass OrdersConfig(AppConfig): name = "apps.orders"\n',
    [p + 'apps/orders/models.py']: 'class Order: ...\n',
    [p + 'apps/orders/admin.py']: [
      'from apps.orders.models import Order',
      'from apps.core.utils import front_url',
      // only a prefix of this exists: the longest one, in whichever root has it, not this app's apps.py
      'import apps.core.missing',
    ].join('\n') + '\n',
    // near miss: an app really importing its own apps.py still gets it
    [p + 'apps/orders/signals.py']: 'from .apps import OrdersConfig\n',
  });
  try {
    run('scan.mjs', root2);
    const scan = readJson(path.join(root2, 'floorplan', '.cache', 'scan.json'));
    const from = (f) => [...new Set(scan.edges.filter((e) => e.from === p + f).map((e) => e.to.slice(p.length)))].sort();
    assert.deepEqual(from('apps/orders/admin.py'), ['apps/core/__init__.py', 'apps/core/utils.py', 'apps/orders/models.py']);
    assert.deepEqual(from('apps/orders/signals.py'), ['apps/orders/apps.py']);
  } finally { cleanup(root2); }
});
