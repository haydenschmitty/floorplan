// FastAPI: an APIRouter(...) is read whole, however deeply its dependencies nest, so a router's sign-in
// check counts for its routes; brackets and Depends() inside strings and comments don't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, makeProject, openEndpoints, readGraph, scanAndBuild } from './helpers.mjs';

const ARCH = {
  project: { name: 'Router dependencies', summary: 'FastAPI router auth regression.' },
  nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'Test server.', paths: ['**'] }],
};
function openIn(py) {
  const root = makeProject({ 'app.py': py }, { arch: ARCH });
  try { scanAndBuild(root); const g = readGraph(root); return { routes: g.routes.length, open: openEndpoints(g) }; } finally { cleanup(root); }
}

test('FastAPI: every router dependency is considered, including nested factories and authenticate', (t) => {
  const root = makeProject({
    'app.py': `from fastapi import APIRouter, Depends, Security

# A router whose dependencies hold a factory called with arguments (a call inside a call inside APIRouter).
tours = APIRouter(
    prefix="/tours",
    tags=["tours"],
    dependencies=[
        Depends(authenticate),
        Depends(require_reviewer),
        Depends(require_workspace("tours", "operate")),
    ],
)
@tours.get("")
async def list_tours():
    return []
@tours.post("/preview")
async def preview_tour():
    return {}

# A database dependency before a guard must not hide the guard.
staff = APIRouter(prefix="/staff", dependencies=[Depends(get_db), Depends(require_reviewer)])
@staff.get("")
async def list_staff():
    return []

# Nested factories, qualified names, Security, and delimiters in strings/comments.
scoped = APIRouter(
    prefix="/scoped",
    dependencies=[Depends(get_db), Security(auth.require_scope("items:read)"))], # ) ]
)
@scoped.get("")
async def scoped_items():
    return []

auth_only = APIRouter(prefix="/auth-only", dependencies=[Depends(authenticate)])
@auth_only.get("")
async def authenticated_items():
    return []

authorized = APIRouter(prefix="/authorized", dependencies=[Depends(authorize)])
@authorized.get("")
async def authorized_items():
    return []

# Database sessions alone do not authenticate, nor does another router's guard.
database = APIRouter(prefix="/database", dependencies=[Depends(get_db), Depends(async_session)])
@database.post("")
async def unguarded_database_write():
    return {}
public = APIRouter(prefix="/open")
@public.post("")
async def unguarded_write():
    return {}
`,
  }, { arch: {
    project: { name: 'Router dependencies', summary: 'FastAPI router auth regression.' },
    nodes: [{ id: 'api', label: 'Server', kind: 'service', summary: 'Test server.', paths: ['**'] }],
  } });
  t.after(() => cleanup(root));
  scanAndBuild(root);
  const graph = readGraph(root);
  assert.equal(graph.routes.length, 8);
  assert.deepEqual(openEndpoints(graph), ['POST /database', 'POST /open']);
});

test('FastAPI: a check named only in a comment or a string inside APIRouter(...) protects nothing', () => {
  const { routes, open } = openIn(`from fastapi import APIRouter, Depends

# the check is commented out, and a description mentions one
reports = APIRouter(
    prefix="/reports",
    dependencies=[
        Depends(get_db),
        # Depends(require_login),
    ],
    description="Add Depends(require_login) before launch )]",
)
@reports.post("/export")
async def export_reports():
    return {}

# a factory with arguments still counts, after a string holding brackets
admin = APIRouter(prefix="/admin", tags=["admin ) ]"], dependencies=[Depends(require_role("admin", scopes=["write"]))])
@admin.post("/purge")
async def purge():
    return {}
`);
  assert.equal(routes, 2);
  assert.deepEqual(open, ['POST /reports/export']);
});

test('FastAPI: a router whose brackets never close protects nothing, and leaves the routers after it alone', () => {
  const { open } = openIn(`from fastapi import APIRouter, Depends

broken = APIRouter(prefix="/broken", dependencies=[Depends(require_login)]
@broken.post("/run")
async def run():
    return {}

later = APIRouter(prefix="/later")
@later.post("/go")
async def go():
    return {}
`);
  assert.deepEqual(open, ['POST /broken/run', 'POST /later/go']);
});
