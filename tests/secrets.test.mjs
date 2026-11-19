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

test('variables a script or pipeline fills in are not passwords, in every common spelling (#107, #108, #110, #116)', () => {
  const sh = (line, p = 'db/init-postgres.sh') => secrets(line, p, 'shell');
  // run.sh (#116): the variable handed to a container, and put into a config file by sed
  assert.deepEqual(sh('mysql_q() { docker exec -i -e MYSQL_PWD="$MYSQL_PASSWORD" app-mysql mysql -uroot "$@"; }\n', 'run.sh'), []);
  assert.deepEqual(sh('  sed -e "s|__MYSQL_PASSWORD__|$MYSQL_PASSWORD|g" "$HERE/Config.toml.template" > "$HERE/Config.toml"\n', 'run.sh'), []);
  // Postgres init scripts: psql variables passed in and read back with :'name'
  assert.deepEqual(sh('psql -v ON_ERROR_STOP=1 -v app_password="$APP_PASSWORD" -v ro_password="${RO_PASSWORD}" <<-EOSQL\n'), []);
  assert.deepEqual(sh("  CREATE ROLE app LOGIN PASSWORD :'app_password';\n  ALTER ROLE ro WITH PASSWORD :'ro_password';\n"), []);
  assert.deepEqual(secrets("ALTER ROLE ro WITH PASSWORD :'ro_password';\n", 'db/01-roles.sql', 'sql'), []);
  assert.deepEqual(sh('export DB_PASSWORD="${POSTGRES_PASSWORD:-postgres}"\nAUTH_TOKEN="$API_USER:$API_TOKEN"\n'), []);
  // pipelines: GitHub Actions, GitLab CI ($VAR), Azure Pipelines ($(var)), compose defaults
  const yml = (text, p = 'ci/image.yml') => findIssues(text, { path: p, category: 'config', lang: 'yaml' }).filter((x) => x.k === 'secret');
  assert.deepEqual(yml('    password: ${{ secrets.REGISTRY_TOKEN }}\n    REGISTRY_PASSWORD: $CI_REGISTRY_PASSWORD\n    password: $(registryPassword)\n'), []);
  assert.deepEqual(yml('      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}\n'), []);
  assert.deepEqual(secrets('password = "#{db_password}"\n', 'config/deploy.rb', 'ruby'), []);
});

test('a password written into a script or pipeline, next to those variables, is still found', () => {
  const sh = (line) => secrets(line, 'db/init-postgres.sh', 'shell');
  assert.equal(sh(`psql -v app_password="${FAKE_PASSWORD}" <<-EOSQL\n`).length, 1);
  assert.equal(sh(`AUTH_TOKEN="$API_USER:${FAKE_PASSWORD}"\n`).length, 1, 'one variable does not excuse the text around it');
  // the same :'…' outside a SQL script is an ordinary key and value
  assert.equal(secrets(`const cfg = { password :'${FAKE_PASSWORD.replace(/-/g, '_')}' };\n`, 'src/db.ts', 'typescript').length, 1);
  assert.equal(findIssues(`    password: ${FAKE_PASSWORD}\n`, { path: 'ci/image.yml', category: 'config', lang: 'yaml' }).filter((x) => x.k === 'secret').length, 1);
});

test('"put your key here" in Portuguese, Spanish, French or German is a placeholder, not a secret (#107, #108, #110)', () => {
  const yml = (text) => findIssues(text, { path: 'deploy/imagem.yml', category: 'config', lang: 'yaml' }).filter((x) => x.k === 'secret');
  const sh = (text) => secrets(text, 'db/init/init-postgres.sh', 'shell');
  for (const value of ['sua-chave-secreta-aqui-123', 'troque-esta-chave-2024', 'altere-este-segredo-2024', 'defina-no-env-123456', 'mude_isto_em_producao_1',
    'gere-uma-chave-com-openssl-rand-hex-32', 'tu_clave_secreta_aqui_1', 'cambia-esta-clave-123', 'votre_cle_secrete_ici_1', 'changez-moi-en-prod-12',
    'deine-geheime-zeichenkette-1', 'exemplo-de-chave-123456', 'generate-with-openssl-rand-hex-32']) {
    assert.deepEqual(yml(`  SECRET_KEY: "${value}"\n  JWT_SECRET: ${value}\n`), [], value);
  }
  assert.deepEqual(yml('  POSTGRES_PASSWORD: "sua_senha_aqui"\n  APP_PASSWORD: troque_esta_senha\n'), []);
  assert.deepEqual(sh('APP_PASSWORD="sua_senha_aqui"\nOCR_PASSWORD="troque-esta-senha"\nPOSTGRES_PASSWORD="defina-uma-senha-forte"\n'), []);
  // whole words only: the same letters inside a random key, or a password that only looks like one of them, are still found
  const key = 'Kq8' + 'sua3Zt0' + 'aqui9LmR4tZ8wNc3Hy7Jk2';
  assert.equal(yml(`  SECRET_KEY: "${key}"\n`).length, 1);
  assert.equal(sh(`OCR_PASSWORD="${'Tr0que' + '1234!'}"\n`).length, 1);
  assert.equal(sh(`APP_PASSWORD="${FAKE_PASSWORD}"\n`).length, 1);
});

test('psql variables without a space, and SQL comments, in a database set-up script are not passwords (#107, #110)', () => {
  const sh = (text) => secrets(text, 'db/init/01-papeis.sh', 'shell');
  assert.deepEqual(sh("psql -v app_password=\"$APP_PASSWORD\" <<-EOSQL\n  ALTER ROLE app PASSWORD:'app_password';\nEOSQL\n"), []);
  assert.deepEqual(sh(`psql <<-EOSQL\n  -- password = 'set from APP_PASSWORD, never written here'\n  -- app_password: '${FAKE_PASSWORD}'\nEOSQL\n`), []);
  assert.deepEqual(secrets(`-- password = '${FAKE_PASSWORD}'\nALTER ROLE ro PASSWORD:'ro_password';\n`, 'db/01-roles.sql', 'sql'), []);
  // the same lines in code that isn't SQL, and a password written in below the comment, are still found
  assert.equal(secrets(`const cfg = { password:'${FAKE_PASSWORD.replace(/-/g, '_')}' };\n`, 'src/db.ts', 'typescript').length, 1);
  assert.equal(secrets(`-- the app's role\npassword = '${FAKE_PASSWORD}'\n`, 'db/01-roles.sql', 'sql').length, 1);
  assert.equal(sh(`psql <<-EOSQL\n  -- app role\nEOSQL\nAPP_PASSWORD="${FAKE_PASSWORD}"\n`).length, 1);
});

test("the answers of a choice and the browser's autofill words are not passwords (#93)", () => {
  const tsx = (line) => secrets(line, 'src/screens/LoginScreen.tsx', 'typescript');
  assert.deepEqual(tsx(`<TextInput autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />\n`), []);
  assert.deepEqual(tsx(`const autofill = { password: "current-password", code: "one-time-code" };\n`), []);
  // a real key and value, and a password given as a choice's fallback, are still found
  assert.equal(tsx(`const login = { password: '${FAKE_PASSWORD}' };\n`).length, 1);
  assert.equal(tsx(`const password = isDev ? devPassword : '${FAKE_PASSWORD}';\n`).length, 1);
});

test('a made-up key with a run of the alphabet in it is a placeholder, even in a well-known format (#101)', () => {
  const ALPHABET = String.fromCharCode(...Array.from({ length: 26 }, (_, i) => 97 + i));
  const DIGITS = Array.from({ length: 10 }, (_, i) => i).join('');
  const dummy = 'ghp_' + ALPHABET + DIGITS + 'AB';
  assert.deepEqual(secrets(`const token = '${dummy}';\n`, 'src/review/reviewFindings.test.ts', 'typescript'), []);
  assert.deepEqual(secrets(`token = "${'ghp_' + 'Q7fK2p' + DIGITS + 'Xv9LmR4tZ8wNc3Hy7Jk2'}"`), []);
  // a random-looking token is still found, in a test file and out of it
  assert.equal(secrets(`const token = '${FAKE_GITHUB_TOKEN}';\n`, 'src/review/reviewFindings.test.ts', 'typescript').length, 1);
  assert.equal(secrets(`token = "${FAKE_GITHUB_TOKEN}"`).length, 1);
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

test('publishable keys, made to be put in web pages, are not secrets; their secret partners are (#119)', () => {
  const body = 'Q7fK2pX9vLm' + 'R4tZ8wNc3Hy';
  const ts = (line, p = 'src/lib/logos.ts') => secrets(line, p, 'typescript');
  for (const key of ['pk_' + body, 'pk_live_' + body + body, 'pk_test_' + body, 'sb_publishable_' + body, 'phc_' + body + body]) {
    assert.deepEqual(ts(`const LOGO_API_KEY = '${key}';\nexport const logo = (d: string) => \`https://img.example.com/\${d}?token=\${LOGO_API_KEY}\`;\n`), [], key);
    assert.deepEqual(ts(`export const config = { token: "${key}" };\n`, 'src/config.ts'), [], key);
  }
  assert.equal(ts(`const STRIPE_API_KEY = 'sk_live_${body}${body}';\n`, 'src/pay.ts').length, 1);
  assert.equal(ts(`const LOGO_API_KEY = 'sk_${body}';\n`).length, 1);
  // a password is chosen by a person, so starting with "pk_" excuses nothing
  assert.equal(ts(`const DB_PASSWORD = 'pk_${body}';\n`, 'src/db.ts').length, 1);
});
