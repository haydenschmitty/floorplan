// Health's secret check: it finds keys and passwords written into code, records only where they are
// and a masked hint, and never keeps the value itself. Secret-looking test values are assembled at
// runtime so none is ever committed to this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, FAKE_PASSWORD } from './helpers.mjs';

const { findIssues } = await lib('health.mjs');
const secrets = (src, path = 'app/config.py', lang = 'python') => findIssues(src, { path, category: 'code', lang }).filter((x) => x.k === 'secret');
const FAKE_GITHUB_TOKEN = 'ghp_' + 'aBcD' + '1e2F3g4H5i6J7k8L9m0N1o2P3q4R5s6T7u8V';

test('a hard-coded password is found, with its line, and masked', () => {
  const [s, ...rest] = secrets(`PORT = 3000\nDB_PASSWORD = "${FAKE_PASSWORD}"\n`);
  assert.equal(rest.length, 0);
  assert.equal(s.line, 2);
  assert.equal(s.name, 'DB_PASSWORD');
  assert.equal(s.sev, 'high');
  assert.equal(s.hint, `${FAKE_PASSWORD.length} characters`, 'a password hint gives only its length');
});

test('a known key format is named after its service and shows only its first characters', () => {
  const [s] = secrets(`token = "${FAKE_GITHUB_TOKEN}"`);
  assert.equal(s.svc, 'GitHub');
  assert.match(s.hint, /^starts “ghp_…”, \d+ characters$/);
});

test('the secret value never appears in what Health records', () => {
  for (const found of [secrets(`DB_PASSWORD = "${FAKE_PASSWORD}"`), secrets(`token = "${FAKE_GITHUB_TOKEN}"`)]) {
    const text = JSON.stringify(found);
    assert.ok(!text.includes(FAKE_PASSWORD) && !text.includes(FAKE_GITHUB_TOKEN.slice(4)), text);
  }
});

test('placeholders, values read from the environment and public settings are not flagged', () => {
  assert.deepEqual(secrets('DB_PASSWORD = "changeme"\nAPI_KEY = "your-api-key-here"\nSECRET = "xxx"\n'), []);
  assert.deepEqual(secrets('DB_PASSWORD = os.environ["DB_PASSWORD"]\nAPI_KEY = os.getenv("API_KEY")\n'), []);
  assert.deepEqual(secrets('API_URL = "https://api.example.com/v1/orders"\n'), []);
  // Supabase's config.toml reads secrets from the environment with env(NAME)
  assert.deepEqual(secrets('s3_secret_key = "env(S3_SECRET_KEY)"\n', 'supabase/config.toml', 'toml'), []);
});

test('a variable handed to a command is not a password, a value written in is', () => {
  const sh = (line) => secrets(line, 'deploy/init.sh', 'shell');
  assert.deepEqual(sh('users=$(MYSQL_PWD="$DB_PASSWORD" mariadb -h "$DB_HOST" -N -e "SELECT 1")\n'), []);
  assert.deepEqual(secrets('$dsn = "$password";\n', 'app/db.php', 'php'), []);
  assert.deepEqual(secrets('set "DB_PASSWORD=%DB_PASSWORD%"\n', 'deploy/start.cmd', 'batch'), []);
  assert.equal(sh(`users=$(MYSQL_PWD="${FAKE_PASSWORD}" mariadb -N -e "SELECT 1")\n`).length, 1);
});

test("a path to one of the project's files under a password-ish key is not a password", () => {
  const php = (line) => secrets(line, 'web/page-paths.php', 'php');
  assert.deepEqual(php("    'confirm_password' => 'resources/js/pages/auth/confirm-password.tsx',\n"), []);
  assert.deepEqual(php("    'reset_password' => 'views/auth/reset-password.blade.php',\n"), []);
  // a value with slashes that isn't a file path is still checked
  assert.equal(php("    'password' => 'k9/Lm2.Qp8x',\n").length, 1);
});

test('a ULID record id under a plain "token" name is not a secret; an access token is', () => {
  // a ULID made now: ten characters of time, then sixteen random ones
  const C = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = Date.now(), time = '';
  for (let i = 0; i < 10; i++) { time = C[t % 32] + time; t = Math.floor(t / 32); }
  const ulid = time + 'Q8RZ4M2KDX7HV3NB';
  const php = (line) => secrets(line, 'app/Http/Resources/RouteResource.php', 'php');
  assert.deepEqual(php(`        routeToken: '${ulid}',\n`), []);
  assert.equal(php(`        accessToken: '${ulid}',\n`).length, 1, 'an access token is never excused');
  // the same shape whose first characters are no date a ULID could have
  assert.equal(php(`        routeToken: '7ZZZZZZZZZ${ulid.slice(10)}',\n`).length, 1);
});

test('tokens that are public by design are not flagged (#23)', () => {
  const hex = [...Array(32)].map((_, i) => '01234567890abcdef'[(i * 7 + 3) % 16]).join('');
  // Cloudflare Web Analytics' beacon token has to be in the page for analytics to work
  const beacon = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${hex}"}'></script>`;
  assert.deepEqual(secrets(beacon, 'site/index.html', 'html'), []);
  // the same value under a secret-sounding name elsewhere is still flagged
  assert.equal(secrets(`ACCESS_TOKEN = "${hex}"`).length, 1);
  // a Mapbox public token
  assert.deepEqual(secrets(`mapboxToken = "pk.${'eyJ1IjoiZXhhbXBsZSIsImEiOiJ'}${hex}.${hex.slice(0, 22)}"`, 'web/map.ts', 'typescript'), []);
});
