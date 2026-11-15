import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createDashboard, createAuthenticator, createCredentialChecker, sameOrigin, csrfAllowed, upstreamCSRFAllowed, validatePrefs, loadConfig, sessionCookie, FAKEIP_CIDR, HOSTS } from '../server.js';
import { injectPreferences } from '../frontends.js';

const auth = `Basic ${Buffer.from('admin:p:a:ss').toString('base64')}`;
// Interactive tests authenticate through the same HTML login form a browser uses.
async function sessionFor(origin, username = 'admin', password = 'p:a:ss') {
  const res = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password, next: '/' }) });
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const session = cookies.find(value => value.startsWith('gateway_session='));
  return session ? session.split(';')[0] : null;
}
const secret = 'backend-secret-never-in-browser', dnsPassword = 'dns-secret';
const html = '<html><head><script src="/_next/main.js"></script></head><body><a href="/plugins">原版 UI</a></body></html>';
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve({ hostname: '127.0.0.1', port: s.address().port })));
function track(s) {
  const sockets = new Set(); s.on('connection', x => { sockets.add(x); x.on('close', () => sockets.delete(x)); });
  return async () => { for (const x of sockets) x.destroy(); await new Promise(resolve => s.close(resolve)); };
}
const reply = (res, data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
async function fixture(t, failed = false) {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-test-')), seen = [], patches = [];
  const group = '策略组 #1 / 主入口', candidate = '香港 / 自动节点组';
  let selected = 'DIRECT';
  const yacdRoot = join(dir, 'yacd');
  await mkdir(yacdRoot);
  await writeFile(join(yacdRoot, 'index.html'), html);
  await writeFile(join(yacdRoot, 'native.js'), 'const untouched = true;');
  const mihomo = http.createServer((req, res) => {
    seen.push({ app: 'mihomo', path: req.url, headers: req.headers, method: req.method });
    if (req.url === '/version') reply(res, { version: 'test-version' }, failed ? 503 : 200);
    else if (req.url === '/connections') reply(res, { connections: [{ id: '1' }], uploadTotal: 10, downloadTotal: 20 });
    else if (req.url === '/configs') reply(res, { secret, message: `embedded ${secret}` });
    else if (req.url === '/compressed') { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end(gzipSync(JSON.stringify({ secret, ok: true }))); }
    else if (req.url === '/empty') { res.writeHead(204, { 'content-type': 'application/json' }); res.end(); }
    else if (req.url === '/proxies') reply(res, { proxies: { [group]: { name: group, type: 'Selector', now: selected, all: ['DIRECT', candidate] }, [candidate]: { name: candidate, type: 'Selector', now: 'DIRECT', all: ['DIRECT'] } } });
    else if (req.url === '/proxies/' + encodeURIComponent(group) && req.method === 'PUT') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const value = JSON.parse(body).name;
          if (!['DIRECT', candidate].includes(value)) { reply(res, { message: 'Proxy does not exist' }, 400); return; }
          selected = value;
          seen.at(-1).body = JSON.parse(body);
          res.writeHead(204, { 'content-type': 'application/json' }); res.end();
        } catch { reply(res, { message: 'Invalid body' }, 400); }
      });
    }
    else reply(res, { path: req.url });
  });
  mihomo.on('upgrade', (req, socket, head) => {
    seen.push({ app: 'ws', path: req.url, headers: req.headers });
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (head.length) socket.write(head); socket.on('data', x => socket.write(x)); socket.on('error', () => {});
  });
  const ui = http.createServer((req, res) => {
    seen.push({ app: 'ui', path: req.url, headers: req.headers });
    if (req.url === '/api/health') reply(res, { version: 'test-dns' });
    else if (req.url === '/api/readyz') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ready'); }
    else if (req.url === '/api/config') reply(res, { source: 'password: ${OXIDNS_API_PASSWORD}' });
    else if (req.url === '/redirect') { res.writeHead(302, { location: '/plugins/' }); res.end(); }
    else if (req.url === '/external') { res.writeHead(302, { location: 'https://evil.invalid/' }); res.end(); }
    else if (req.url === '/_next/main.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('fetch("/api/health");const route="/plugins";'); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }
  });
  let prefs = { WantRunning: true, ShieldsUp: false, AdvertiseRoutes: [], AuthKey: 'not-public' };
  const ts = http.createServer(async (req, res) => {
    seen.push({ app: 'ts', path: req.url, headers: req.headers });
    if (req.url === '/localapi/v0/status') reply(res, { BackendState: 'Running', Self: { HostName: 'test-self', Online: true }, Peer: {}, CurrentTailnet: { Name: 'test-tailnet' } });
    else if (req.method === 'PATCH') {
      let body = ''; for await (const x of req) body += x;
      const patch = JSON.parse(body); patches.push(patch);
      prefs = { ...prefs, ...Object.fromEntries(Object.entries(patch).filter(([k]) => !k.endsWith('Set'))) }; reply(res, prefs);
    } else reply(res, prefs);
  });
  const closeM = track(mihomo), closeUI = track(ui), closeTS = track(ts);
  const mTarget = await listen(mihomo), uiTarget = await listen(ui), tsSocket = join(dir, 'ts.sock');
  await new Promise(resolve => ts.listen(tsSocket, resolve));
  const board = createDashboard({ user: 'admin', password: 'p:a:ss', secret, oxidnsPassword: dnsPassword, tsSocket, mihomo: mTarget, yacdRoot, oxidns: uiTarget });
  const closeB = track(board), address = await listen(board), origin = `http://${address.hostname}:${address.port}`;
  t.after(async () => { await closeB(); await Promise.all([closeM(), closeUI(), closeTS()]); await rm(dir, { recursive: true, force: true }); });
  const cookie = await sessionFor(origin);
  const get = (path, options = {}, host) => fetch(origin + path, { redirect: 'manual', ...options, headers: { Cookie: cookie, ...(host ? { Host: host } : {}), ...options.headers } });
  const native = (app, path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ ...address, path, method: options.method || 'GET', headers: { Cookie: cookie, Host: HOSTS[app], ...options.headers } }, res => {
      const chunks = []; res.on('data', x => chunks.push(x)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: { get: key => { const value = res.headers[key.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value ?? null; } }, text: async () => text, json: async () => JSON.parse(text) }); });
    }); req.on('error', reject); req.end(options.body);
  });
  const post = body => get('/api/tailscale/prefs', { method: 'POST', headers: { Origin: origin, 'X-Dashboard-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { get, native, post, address, origin, seen, patches, group, candidate };
}
test('login form credential check uses constant-time comparison and bounded rate limit', () => {
  let now = 0; const check = createCredentialChecker('admin', 'p:a:ss', { now: () => now, attempts: 2, windowMs: 100 });
  const req = { socket: { remoteAddress: 'test' } };
  assert.equal(check({ user: 'admin', pass: 'p:a:ss' }, req), 200); assert.equal(check({ user: 'admin', pass: 'wrong' }, req), 401); assert.equal(check({ user: '', pass: '' }, req), 401);
  assert.equal(check({ user: 'admin', pass: 'p:a:ss' }, req), 429); now = 101; assert.equal(check({ user: 'admin', pass: 'p:a:ss' }, req), 200);
});
test('signed host-only sessions work without exposing passwords and reject tampering/expiry', () => {
  const cookie = sessionCookie('p:a:ss', true, 1000); assert(cookie.includes('HttpOnly; SameSite=Strict')); assert(cookie.endsWith('; Secure'));
  const check = createAuthenticator('admin', 'p:a:ss', { now: () => 1000 });
  const req = x => ({ headers: { cookie: x }, socket: {} });
  assert.equal(check(req(cookie.split(';')[0])), 200); assert.equal(check(req(cookie.replace(/\.[a-f0-9]/, '.z'))), 401);
  assert.equal(createAuthenticator('admin', 'p:a:ss', { now: () => 29_000_000 })(req(cookie)), 401);
});
test('own CSRF requires custom header, native UI CSRF uses Origin and non-simple JSON', () => {
  const req = (origin, headers = {}, method = 'POST') => ({ method, headers: { host: 'board.test', origin, ...headers } });
  assert(sameOrigin(req('https://board.test'))); assert(csrfAllowed(req('https://board.test', { 'x-dashboard-request': '1' })));
  for (const origin of [undefined, 'null', 'https://evil.test', 'https://board.test/path', 'https://user@board.test']) assert(!sameOrigin(req(origin)));
  assert(!csrfAllowed(req('https://board.test')));
  assert(upstreamCSRFAllowed(req('https://board.test', { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' })));
  assert(!upstreamCSRFAllowed(req('https://board.test', { 'content-type': 'text/plain' })));
  assert(!upstreamCSRFAllowed(req('https://board.test', { 'content-type': 'application/json', 'sec-fetch-site': 'same-site' })));
  assert(upstreamCSRFAllowed(req('https://board.test', {}, 'DELETE')));
  for (const method of ['PUT', 'PATCH']) {
    assert(upstreamCSRFAllowed(req('https://board.test', { 'content-type': 'text/plain;charset=UTF-8', 'sec-fetch-site': 'same-origin' }, method)));
    assert(upstreamCSRFAllowed(req('https://board.test', {}, method)));
    assert(!upstreamCSRFAllowed(req('https://evil.test', { 'content-type': 'text/plain' }, method)));
    assert(!upstreamCSRFAllowed(req('https://board.test', { 'content-type': 'text/plain', 'sec-fetch-site': 'same-site' }, method)));
  }
});
test('Tailscale EditedPrefs permits only three fields and the fixed fake-IP subnet', () => {
  assert.deepEqual(validatePrefs({ WantRunning: false, AdvertiseRoutes: [FAKEIP_CIDR] }), { WantRunning: false, WantRunningSet: true, AdvertiseRoutes: [FAKEIP_CIDR], AdvertiseRoutesSet: true });
  for (const x of [null, [], {}, { AuthKey: 'x' }, { ExitNodeID: 'x' }, { CorpDNS: true }, { ShieldsUp: 1 }, { AdvertiseRoutes: ['0.0.0.0/0'] }]) assert.throws(() => validatePrefs(x));
});
test('startup reads credential files and enforces a fixed subnet', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gateway-creds-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { DASHBOARD_USER: 'admin', DASHBOARD_PASSWORD_FILE: join(dir, 'password'), MIHOMO_SECRET_FILE: join(dir, 'secret'), OXIDNS_PASSWORD_FILE: join(dir, 'dns') };
  await writeFile(env.DASHBOARD_PASSWORD_FILE, 'p:a:ss\n'); await writeFile(env.MIHOMO_SECRET_FILE, secret); await writeFile(env.OXIDNS_PASSWORD_FILE, dnsPassword);
  assert.equal((await loadConfig(env)).password, 'p:a:ss'); await assert.rejects(loadConfig({ ...env, FAKEIP_CIDR: '0.0.0.0/0' }));
});
test('only health is public; all subdomains and assets need authentication', async t => {
  const { origin } = await fixture(t); assert.equal((await fetch(origin + '/healthz')).status, 200);
  for (const path of ['/', '/app.js']) assert.equal((await fetch(origin + path, { redirect: 'manual' })).status, 303);
  // The login form needs its stylesheet and script before authentication.
  for (const path of ['/style.css', '/login.js', '/favicon.svg', '/_gateway/preferences.js', '/_gateway/upstream-preferences.js']) assert.equal((await fetch(origin + path)).status, 200);
  assert.equal((await fetch(origin + '/api/overview', { redirect: 'manual' })).status, 401);
  for (const host of [HOSTS.mihomo, HOSTS.oxidns]) assert.equal((await fetch(origin + '/', { headers: { Host: host }, redirect: 'manual' })).status, 303);
});
test('partial health data is real, readyz plaintext is accepted, secrets are absent', async t => {
  const { get } = await fixture(t, true); const data = await (await get('/api/overview')).json();
  assert.equal(data.services.mihomo.ok, false); assert.equal(data.services.mihomo.version, null); assert.equal(data.services.mihomo.connections, 1);
  assert.equal(data.services.oxidns.ok, true); assert.equal(data.services.tailscale.state, 'Running'); assert(!JSON.stringify(data).includes('not-public'));
});
test('Tailscale changes enforce CSRF and whitelist then PATCH only the Unix socket', async t => {
  const { get, post, patches, seen } = await fixture(t);
  assert.equal((await get('/api/tailscale/prefs', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await post({ AuthKey: 'bad' })).status, 400); assert.equal(patches.length, 0);
  assert.equal((await post({ ShieldsUp: true })).status, 200); assert.deepEqual(patches, [{ ShieldsUp: true, ShieldsUpSet: true }]);
  assert(seen.some(x => x.app === 'ts' && x.headers.host === 'local-tailscaled.sock' && !x.headers.authorization));
});
test('logout revokes the presented session even if the old cookie is replayed', async t => {
  const { origin } = await fixture(t);
  const cookie = await sessionFor(origin);
  assert.equal((await fetch(origin + '/api/overview', { headers: { Cookie: cookie } })).status, 200);
  const logout = await fetch(origin + '/logout', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: origin, 'X-Dashboard-Request': '1', 'Content-Length': '0' } });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(origin + '/api/overview', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(origin + '/api/overview', { headers: { Cookie: cookie }, redirect: 'manual' })).status, 401);
});
test('dashboard entry redirects use HTTPS subdomains with no extra port', async t => {
  const { get } = await fixture(t); for (const app of ['mihomo', 'oxidns']) {
    const res = await get(`/${app}/`); assert.equal(res.status, 302); assert.equal(res.headers.get('location'), `https://${HOSTS[app]}/`);
  }
});
test('OxiDNS receives an early preferences bootstrap while native scripts, navigation and API remain intact', async t => {
  const { native, seen } = await fixture(t);
  const page = await (await native('oxidns', '/')).text();
  assert.equal(page, injectPreferences(html, 'oxidns'));
  assert(page.indexOf('/_gateway/preferences.js') < page.indexOf('/_next/main.js'));
  assert.equal(await (await native('oxidns', '/_next/main.js')).text(), 'fetch("/api/health");const route="/plugins";');
  assert.equal((await native('oxidns', '/redirect')).headers.get('location'), '/plugins/');
  assert.equal((await native('oxidns', '/external')).status, 502);
  const config = await (await native('oxidns', '/api/config')).json(); assert.equal(config.source, 'password: ${OXIDNS_API_PASSWORD}');
  assert(seen.some(x => x.app === 'ui' && x.headers.authorization === `Basic ${Buffer.from(`admin:${dnsPassword}`).toString('base64')}`));
  assert(!seen.some(x => x.app === 'ui' && x.headers.cookie?.includes(dnsPassword)));
});
test('mihomo serves bundled Yacd with preferences, server-side Bearer, fixed upstream and redaction', async t => {
  const { native, get, seen } = await fixture(t);
  assert.equal(await (await native('mihomo', '/')).text(), injectPreferences(html, 'yacd'));
  assert.equal(await (await native('mihomo', '/native.js')).text(), 'const untouched = true;');
  assert.equal((await native('mihomo', '/config.js')).status, 404);
  assert.equal((await native('mihomo', '/proxies')).headers.get('location'), '/#/proxies');
  const head = await native('mihomo', '/', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal((await native('mihomo', '/%2f..%2fserver.js')).status, 404);
  const res = await native('mihomo', '/mihomo-api/configs');
  assert(!JSON.stringify(await res.json()).includes(secret)); assert(seen.some(x => x.app === 'mihomo' && x.headers.authorization === `Bearer ${secret}`));
  assert.equal((await native('mihomo', '/mihomo-api/compressed')).status, 200); assert.equal((await native('mihomo', '/mihomo-api/empty')).status, 204);
  await native('mihomo', '/mihomo-api/echo?token=secret&x=1'); assert(seen.some(x => x.path === '/echo?x=1'));
  assert.equal((await get('/proxy?url=http://evil.invalid')).status, 404);
  const options = { method: 'PATCH', body: '{}', headers: { Origin: `https://${HOSTS.mihomo}`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' } };
  assert.equal((await native('mihomo', '/mihomo-api/configs', options)).status, 200);
  assert.equal((await native('mihomo', '/mihomo-api/configs', { ...options, headers: { ...options.headers, Origin: 'https://evil.invalid' } })).status, 403);
});
test('same-origin native clients switch encoded Chinese node groups with JSON or text/plain and receive an empty 204', async t => {
  const { native, seen, group, candidate } = await fixture(t);
  const path = '/mihomo-api/proxies/' + encodeURIComponent(group);
  const headers = { Origin: `https://${HOSTS.mihomo}`, 'Sec-Fetch-Site': 'same-origin' };
  for (const [type, name] of [['text/plain;charset=UTF-8', candidate], ['application/json', 'DIRECT']]) {
    const response = await native('mihomo', path, { method: 'PUT', headers: { ...headers, 'Content-Type': type }, body: JSON.stringify({ name }) });
    assert.equal(response.status, 204); assert.equal(await response.text(), '');
    assert.equal((await (await native('mihomo', '/mihomo-api/proxies')).json()).proxies[group].now, name);
    const request = seen.findLast(entry => entry.method === 'PUT');
    assert.equal(request.path, '/proxies/' + encodeURIComponent(group));
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    assert.deepEqual(request.body, { name });
  }
  for (const origin of [undefined, 'https://evil.invalid']) {
    const response = await native('mihomo', path, { method: 'PUT', headers: { ...headers, Origin: origin || '', 'Content-Type': 'text/plain' }, body: JSON.stringify({ name: candidate }) });
    assert.equal(response.status, 403);
  }
  assert.equal((await (await native('mihomo', '/mihomo-api/proxies')).json()).proxies[group].now, 'DIRECT');
});
async function upgrade(address, headers = {}, path = '/mihomo-api/traffic?token=never-forward', host = HOSTS.mihomo) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address.port, address.hostname); let text = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('WS timeout')); }); socket.on('error', reject);
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`));
    socket.on('data', x => { text += x; if (text.includes('\r\n\r\n')) { socket.destroy(); resolve(text); } });
  });
}
test('browser WebSocket authenticates with host-only cookie and enforces same-origin', async t => {
  const { address, seen } = await fixture(t);
  assert.match(await upgrade(address), /^HTTP\/1.1 401/);
  const cookie = sessionCookie('p:a:ss').split(';')[0];
  assert.match(await upgrade(address, { Cookie: cookie, Origin: 'https://evil.invalid' }), /^HTTP\/1.1 403/);
  assert.match(await upgrade(address, { Cookie: cookie, Origin: `https://${HOSTS.mihomo}` }), /^HTTP\/1.1 101/);
  const req = seen.find(x => x.app === 'ws'); assert.equal(req.path, '/traffic'); assert.equal(req.headers.authorization, `Bearer ${secret}`);
});
