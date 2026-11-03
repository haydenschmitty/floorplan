import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, makeProject, openEndpoints, readGraph, scanAndBuild } from './helpers.mjs';

test('FastAPI: every router dependency is considered, including nested factories and authenticate', (t) => {
  const root = makeProject({
    'app.py': `from fastapi import APIRouter, Depends, Security

# Cambria's router: the first dependency used to be truncated at its first ).
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
