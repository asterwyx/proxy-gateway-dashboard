import http from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { injectPreferences, readYacdAsset } from './frontends.js';

export const FAKEIP_CIDR = '198.20.0.0/16';
export const HOSTS = { dashboard: 'board.proxy.asterwyx.top', mihomo: 'mihomo.proxy.asterwyx.top', oxidns: 'oxidns.proxy.asterwyx.top' };
const PUBLIC = new URL('./public/', import.meta.url);
const LIMIT = 8 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest();
const hop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer']);
const safeHeaders = headers => {
  const forbidden = new Set([...hop, ...(headers.connection || '').toLowerCase().split(',').map(x => x.trim()),
    'authorization', 'cookie', 'set-cookie', 'host', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-dashboard-request',
    'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods', 'access-control-allow-headers']);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !forbidden.has(key.toLowerCase())));
};
const security = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'x-frame-options': 'SAMEORIGIN', 'cache-control': 'no-store',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
const json = (res, code, data, headers = {}) => {
  res.writeHead(code, { ...security, 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
};

export async function loadConfig(env = process.env) {
  const load = async path => (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
  const user = env.DASHBOARD_USER;
  const password = await load(env.DASHBOARD_PASSWORD_FILE || '/run/secrets/dashboard-password');
  const secret = await load(env.MIHOMO_SECRET_FILE || '/run/secrets/mihomo-secret');
  const oxidnsPassword = await load(env.OXIDNS_PASSWORD_FILE || '/run/secrets/oxidns-password');
  const oxidnsUser = env.OXIDNS_USER || 'admin';
  if (!user || user.includes(':') || oxidnsUser.includes(':') || !password || !secret || !oxidnsPassword) throw new Error('Missing or invalid credentials');
  if (env.FAKEIP_CIDR && env.FAKEIP_CIDR !== FAKEIP_CIDR) throw new Error('Only the fixed fake-IP route is supported');
  return { user, password, secret, oxidnsUser, oxidnsPassword, tsSocket: env.TS_SOCKET || '/var/run/tailscale/tailscaled.sock' };
}

export function sameOrigin(req) {
  try {
    const url = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === req.headers.origin && url.host.toLowerCase() === req.headers.host?.toLowerCase();
  } catch { return false; }
}
export const csrfAllowed = req => sameOrigin(req) && req.headers['x-dashboard-request'] === '1';
// Native clients may send JSON strings as text/plain (for example ky's body
// option). PUT/PATCH/DELETE are already non-simple methods: cross-origin forms
// cannot send them. Only POST needs the extra simple-content-type restriction.
export const upstreamCSRFAllowed = req => sameOrigin(req) &&
  (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site'] === 'same-origin') &&
  (req.method !== 'POST' ||
   /^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') ||
   (req.headers['content-length'] === '0' && !req.headers['transfer-encoding']));

const signSession = (expiry, password) => createHmac('sha256', password).update(`gateway-session:${expiry}`).digest('hex');
// The session is shared only by the managed subdomains of proxy.asterwyx.top.
// Upstream UIs cannot read it through JavaScript because it is HttpOnly.
export const COOKIE_DOMAIN = 'proxy.asterwyx.top';
export function sessionCookie(password, secure = true, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + 8 * 3600;
  return `gateway_session=${expiry}.${signSession(expiry, password)}; Domain=${COOKIE_DOMAIN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`;
}
function validSession(cookies, password, now) {
  const value = (cookies || '').split(';').map(x => x.trim()).find(x => x.startsWith('gateway_session='))?.slice(16);
  if (!value || !/^\d+\.[a-f0-9]{64}$/.test(value)) return false;
  const [expiry, signature] = value.split('.');
  if (Number(expiry) <= Math.floor(now / 1000) || Number(expiry) > Math.floor(now / 1000) + 28800) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signSession(expiry, password), 'hex'));
}

export function loginCookie(password, secure = true, now = Date.now()) { return sessionCookie(password, secure, now); }

// Signed cookies are stateless, so explicitly revoke the presented session on
// logout. Entries expire no later than the session itself.
export function createSessionStore() {
  const revoked = new Map();
  const sessionFrom = cookies => {
    const value = (cookies || '').split(';').map(x => x.trim()).find(x => x.startsWith('gateway_session='))?.slice(16);
    return value && /^\d+\.[a-f0-9]{64}$/.test(value) ? value : null;
  };
  return {
    sessionFrom,
    valid(cookies, password, now) {
      const value = sessionFrom(cookies);
      if (!value) return false;
      const expiry = Number(value.split('.')[0]), current = Math.floor(now / 1000);
      for (const [key, until] of revoked) if (until <= current) revoked.delete(key);
      if (revoked.has(value)) return false;
      if (expiry <= current || expiry > current + 28800) return false;
      const signature = value.split('.')[1];
      return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(signSession(expiry, password), 'hex'));
    },
    revoke(cookies, now) {
      const value = sessionFrom(cookies);
      if (value) {
        const expiry = Number(value.split('.')[0]);
        revoked.set(value, expiry > 0 ? expiry : Math.floor(now / 1000));
      }
      return value;
    },
  };
}
export function clearSessionCookie(secure = true) {
  return `gateway_session=; Domain=${COOKIE_DOMAIN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
// Constant-time credential check for the login form. Failures are rate-limited
// per TCP source; the password itself is never logged or echoed back.
export function createCredentialChecker(user, password, { now = Date.now, attempts = 8, windowMs = 60_000 } = {}) {
  const userHash = digest(user), passHash = digest(password), failures = new Map();
  return ({ user: name, pass }, req) => {
    const time = now(), ip = req.socket.remoteAddress || 'unknown';
    for (const [key, entry] of failures) if (time >= entry.until) failures.delete(key);
    const entry = failures.get(ip);
    if (entry?.count >= attempts || (!entry && failures.size >= 4096)) return 429;
    const nameOK = timingSafeEqual(digest(String(name)), userHash), passOK = timingSafeEqual(digest(String(pass)), passHash);
    if (nameOK && passOK) { failures.delete(ip); return 200; }
    failures.set(ip, { count: (entry?.count || 0) + 1, until: entry?.until || time + windowMs });
    return 401;
  };
}
export function createAuthenticator(user, password, { now = Date.now, attempts = 8, windowMs = 60_000, sessions = createSessionStore() } = {}) {
  const userHash = digest(user), passHash = digest(password), failures = new Map();
  return req => {
    if (sessions.valid(req.headers.cookie, password, now())) return 200;
    const time = now(), ip = req.socket.remoteAddress || 'unknown';
    for (const [key, entry] of failures) if (time >= entry.until) failures.delete(key);
    const entry = failures.get(ip);
    if (entry?.count >= attempts || (!entry && failures.size >= 4096)) return 429;
    failures.set(ip, { count: (entry?.count || 0) + 1, until: entry?.until || time + windowMs });
    return 401;
  };
}

export function validatePrefs(body) {
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('Invalid preferences');
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !['ShieldsUp', 'WantRunning', 'AdvertiseRoutes'].includes(key))) throw new Error('Unsupported preference');
  const patch = {};
  for (const key of keys) {
    const value = body[key];
    if (key === 'AdvertiseRoutes') {
      if (!Array.isArray(value) || !(value.length === 0 || (value.length === 1 && value[0] === FAKEIP_CIDR))) throw new Error('Unsupported route');
    } else if (typeof value !== 'boolean') throw new Error('Boolean required');
    patch[key] = value; patch[`${key}Set`] = true;
  }
  return patch;
}

const request = (target, path, { method = 'GET', body, headers = {}, maxBytes = LIMIT } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ ...target, path, method, headers }, res => {
    const chunks = []; let size = 0;
    res.on('data', chunk => { size += chunk.length; if (size > maxBytes) res.destroy(new Error('Upstream response too large')); else chunks.push(chunk); });
    res.on('error', reject);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.setTimeout(3500, () => req.destroy(new Error('Upstream timeout')));
  req.on('error', reject); req.end(body);
});
const requestJSON = async (target, path, options) => {
  const res = await request(target, path, options);
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(res.body.toString('utf8'));
};
const prefsView = prefs => ({ ShieldsUp: prefs.ShieldsUp, WantRunning: prefs.WantRunning, AdvertiseRoutes: prefs.AdvertiseRoutes || [] });
// Show the Tailscale machine name (the DNS label), not the OS hostname.
// iOS devices often report HostName="localhost", which is not a usable label.
const machineName = peer => {
  const label = String(peer.DNSName || '').replace(/\.$/, '').split('.')[0];
  return label || peer.HostName || '';
};
const peerView = peer => ({ id: peer.ID, name: machineName(peer), dnsName: peer.DNSName, hostName: peer.HostName || null,
  ips: peer.TailscaleIPs || [], online: peer.Online === true, os: peer.OS, lastSeen: peer.LastSeen || null,
  rxBytes: peer.RxBytes ?? null, txBytes: peer.TxBytes ?? null });
const degraded = error => ({ ok: false, error: /^HTTP \d{3}$/.test(error.message) ? error.message : '服务不可达或响应无效' });

export function createDashboard(config) {
  const { user, password, secret } = config;
  const mihomo = config.mihomo || { hostname: '127.0.0.1', port: 9090 };
  const ts = { socketPath: config.tsSocket, headers: { host: 'local-tailscaled.sock' } };
  const tsHeaders = { host: 'local-tailscaled.sock', 'content-type': 'application/json' };
  const oxidns = config.oxidns || { hostname: '127.0.0.1', port: 9199 };
  const bearer = { authorization: `Bearer ${secret}` };
  const oxidnsAuth = { authorization: `Basic ${Buffer.from(`${config.oxidnsUser || 'admin'}:${config.oxidnsPassword}`).toString('base64')}` };
  const sessions = createSessionStore();
  const authenticate = createAuthenticator(user, password, { ...config.authOptions, sessions });
  const hosts = config.hosts || HOSTS;
  const mihomoAPI = { prefix: '/mihomo-api/', target: mihomo, api: true };
  const mihomoUI = { yacd: true };
  const oxidnsProxy = { prefix: '/', target: oxidns, oxidns: true };
  const hostname = req => (req.headers.host || '').split(':')[0].toLowerCase();
  const findProxy = (req, path) => {
    if (hostname(req) === hosts.oxidns) return oxidnsProxy;
    if (hostname(req) === hosts.mihomo) return path.startsWith(mihomoAPI.prefix) ? mihomoAPI : mihomoUI;
    return null;
  };
  const upstreamPath = (url, proxy) => {
    const next = new URL(url, 'http://dashboard.invalid');
    if (proxy.api) next.searchParams.delete('token');
    return next.pathname.slice(proxy.prefix.length - 1) + next.search;
  };
  const loginAuthenticator = createCredentialChecker(user, password, config.authOptions);
  const authResponse = (req, res) => {
    const status = authenticate(req);
    if (status === 200) return true;
    if (status === 429) { json(res, 429, { error: '请求过于频繁，请稍后重试' }, { 'retry-after': '60' }); return false; }
    // Unauthenticated page requests go to the form; API calls receive JSON 401.
    const path = new URL(req.url, 'http://dashboard.invalid').pathname;
    if (['GET', 'HEAD'].includes(req.method) && !path.startsWith('/api/') && !path.startsWith('/mihomo-api/')) {
      res.writeHead(303, { ...security, location: `/login?next=${encodeURIComponent(req.url)}` }); res.end(); return false;
    }
    json(res, 401, { error: '需要身份验证' });
    return false;
  };
  const safeNext = value => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) ? value : '/';
  async function readForm(req, limit = 4096) {
    let text = '';
    for await (const chunk of req) { text += chunk.toString('utf8'); if (Buffer.byteLength(text) > limit) throw new Error('form too large'); }
    return new URLSearchParams(text);
  }
  async function handleLogin(req, res) {
    const secure = true;
    if (req.method === 'GET') {
      res.writeHead(200, { ...security, 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'" });
      res.end(await readFile(new URL('login.html', PUBLIC))); return;
    }
    if (req.method === 'POST') {
      let form;
      try { form = await readForm(req); } catch { json(res, 413, { error: '请求体过大' }); return; }
      const next = safeNext(form.get('next'));
      const status = loginAuthenticator({ user: form.get('username') || '', pass: form.get('password') || '' }, req);
      if (status === 429) { json(res, 429, { error: '请求过于频繁，请稍后重试' }, { 'retry-after': '60' }); return; }
      if (status !== 200) { res.writeHead(303, { ...security, location: `/login?error=1&next=${encodeURIComponent(next)}` }); res.end(); return; }
      res.writeHead(303, { ...security, location: next, 'set-cookie': loginCookie(password, secure) }); res.end(); return;
    }
    json(res, 405, { error: '方法不允许' });
  }
  async function overview() {
    const tasks = {
      mihomo: (async () => {
        const [version, traffic] = await Promise.allSettled([
          requestJSON(mihomo, '/version', { headers: bearer }), requestJSON(mihomo, '/connections', { headers: bearer }),
        ]);
        return { ok: version.status === 'fulfilled' && traffic.status === 'fulfilled',
          version: version.status === 'fulfilled' ? version.value.version : null,
          connections: traffic.status === 'fulfilled' ? (Array.isArray(traffic.value.connections) ? traffic.value.connections.length : traffic.value.connections === null ? 0 : null) : null,
          uploadBytes: traffic.status === 'fulfilled' ? traffic.value.uploadTotal ?? null : null,
          downloadBytes: traffic.status === 'fulfilled' ? traffic.value.downloadTotal ?? null : null,
          memoryBytes: traffic.status === 'fulfilled' ? traffic.value.memory ?? null : null,
          ...((version.status === 'rejected' || traffic.status === 'rejected') ? { error: '部分 mihomo 数据不可用' } : {}) };
      })(),
      tailscale: (async () => {
        const [status, prefs] = await Promise.allSettled([
          requestJSON(ts, '/localapi/v0/status', { headers: tsHeaders }), requestJSON(ts, '/localapi/v0/prefs', { headers: tsHeaders }),
        ]);
        const data = status.status === 'fulfilled' ? status.value : null;
        return { ok: data?.BackendState === 'Running' && prefs.status === 'fulfilled', state: data?.BackendState ?? null,
          self: data?.Self ? peerView(data.Self) : null, peers: data ? Object.values(data.Peer || {}).map(peerView) : null,
          tailnet: data?.CurrentTailnet?.Name ?? null, health: data?.Health || [],
          prefs: prefs.status === 'fulfilled' ? prefsView(prefs.value) : null,
          ...((!data || prefs.status === 'rejected') ? { error: '部分 Tailscale 数据不可用' } : data.BackendState !== 'Running' ? { error: `Tailscale 尚未接入 tailnet：${data.BackendState}` } : {}) };
      })(),
      oxidns: (async () => {
        const [health, ready] = await Promise.allSettled([
          requestJSON(oxidns, '/api/health', { headers: oxidnsAuth, maxBytes: 65536 }),
          request(oxidns, '/api/readyz', { headers: oxidnsAuth, maxBytes: 65536 }).then(res => {
            if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
          }),
        ]);
        return { ok: health.status === 'fulfilled' && ready.status === 'fulfilled', probe: 'HTTP /api/health + /api/readyz（非 DNS 查询测试）',
          version: health.status === 'fulfilled' ? health.value.version ?? null : null,
          uptimeMs: health.status === 'fulfilled' ? health.value.uptime_ms ?? null : null,
          ...((health.status === 'rejected' || ready.status === 'rejected') ? { error: 'OxiDNS 健康或就绪探测失败' } : {}) };
      })(),
    };
    const entries = await Promise.all(Object.entries(tasks).map(async ([key, task]) => {
      try { return [key, await task]; } catch (error) { return [key, degraded(error)]; }
    }));
    return { updatedAt: new Date().toISOString(), fakeIPCIDR: FAKEIP_CIDR, services: Object.fromEntries(entries) };
  }
  function proxyHTTP(req, res, proxy) {
    const headers = { ...safeHeaders(req.headers), ...(proxy.api ? bearer : proxy.oxidns ? oxidnsAuth : {}), 'accept-encoding': 'identity' };
    const upstream = http.request({ ...proxy.target, path: upstreamPath(req.url, proxy), method: req.method, headers }, remote => {
      const type = remote.headers['content-type'] || '';
      const outputHeaders = { ...safeHeaders(remote.headers), ...security };
      if (remote.headers.location) {
        try {
          const base = `http://${proxy.target.hostname}:${proxy.target.port}`;
          const location = new URL(remote.headers.location, base);
          if (location.origin !== base) { remote.resume(); json(res, 502, { error: '拒绝上游跨站重定向' }); return; }
          outputHeaders.location = proxy.prefix.slice(0, -1) + location.pathname + location.search + location.hash;
        } catch { remote.resume(); json(res, 502, { error: '上游重定向无效' }); return; }
      }
      const noBody = req.method === 'HEAD' || [204, 304].includes(remote.statusCode);
      const html = proxy.oxidns && remote.statusCode === 200 && /text\/html/i.test(type);
      if (!noBody && ((proxy.api && /json/i.test(type)) || html)) {
        const chunks = []; let size = 0;
        remote.on('data', chunk => { size += chunk.length; if (size > LIMIT) remote.destroy(new Error('Response too large')); else chunks.push(chunk); });
        remote.on('end', () => {
          try {
            let buffer = Buffer.concat(chunks);
            const decode = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[remote.headers['content-encoding']];
            if (decode) buffer = decode(buffer, { maxOutputLength: LIMIT });
            else if (remote.headers['content-encoding'] && remote.headers['content-encoding'] !== 'identity') throw new Error('Unsupported encoding');
            let text = buffer.toString('utf8');
            if (html) text = injectPreferences(text, 'oxidns');
            else if (text) text = JSON.stringify(JSON.parse(text), (key, value) =>
              key.toLowerCase() === 'secret' ? '[redacted]' : typeof value === 'string' ? value.replaceAll(secret, '[redacted]') : value);
            delete outputHeaders['content-length']; delete outputHeaders['content-encoding']; delete outputHeaders.etag;
            res.writeHead(remote.statusCode, outputHeaders); res.end(text);
          } catch { if (!res.headersSent) json(res, 502, { error: '上游内容无效' }); else res.destroy(); }
        });
      } else { res.writeHead(remote.statusCode, outputHeaders); remote.pipe(res); }
      remote.on('error', () => { if (!res.headersSent) json(res, 502, { error: '上游响应中断' }); else res.destroy(); });
    });
    upstream.setTimeout(15000, () => upstream.destroy(new Error('Timeout')));
    upstream.on('error', () => { if (!res.headersSent && !res.destroyed) json(res, 502, { error: '上游服务不可达' }); else res.destroy(); });
    res.on('close', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    let size = 0;
    req.pipe(new Transform({ transform(chunk, encoding, next) { size += chunk.length; next(size > LIMIT ? new Error('Body too large') : null, chunk); } }))
      .on('error', () => { upstream.destroy(); if (!res.headersSent) json(res, 413, { error: '请求体过大' }); }).pipe(upstream);
  }
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    try {
      const path = new URL(req.url, 'http://dashboard.invalid').pathname;
      if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) { json(res, 200, { ok: true }); return; }
      if (path === '/login') { await handleLogin(req, res); return; }
      // Public login assets must be reachable before authentication or the form
      // renders unstyled; they contain no credentials or upstream data.
      const loginAssets = { '/style.css': ['style.css', 'text/css'], '/login.js': ['login.js', 'text/javascript'], '/i18n.js': ['i18n.js', 'text/javascript'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
        '/_gateway/preferences.js': ['preferences.js', 'text/javascript'], '/_gateway/upstream-preferences.js': ['upstream-preferences.js', 'text/javascript'] };
      if (loginAssets[path] && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = loginAssets[path];
        res.writeHead(200, { ...security, 'content-type': `${type}; charset=utf-8` });
        res.end(req.method === 'HEAD' ? undefined : await readFile(new URL(file, PUBLIC))); return;
      }
      if (path === '/logout' && req.method === 'POST') {
        if (!csrfAllowed(req) && !sameOrigin(req)) { json(res, 403, { error: 'CSRF 检查失败' }); return; }
        sessions.revoke(req.headers.cookie, Date.now());
        res.writeHead(303, { ...security, location: '/login', 'set-cookie': clearSessionCookie(true) }); res.end(); return;
      }
      if (!authResponse(req, res)) return;
      const native = findProxy(req, path);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !(native ? upstreamCSRFAllowed(req) : csrfAllowed(req))) {
        json(res, 403, { error: 'CSRF 检查失败' }); return;
      }
      if (native) {
        if (native.yacd) {
          if (!['GET', 'HEAD'].includes(req.method)) { json(res, 405, { error: '方法不允许' }); return; }
          // Preserve bookmarks from the previous frontend's pathname router.
          if (['/proxies', '/rules', '/connections', '/configs', '/logs'].includes(path)) {
            res.writeHead(302, { ...security, location: '/#' + path }); res.end(); return;
          }
          const asset = await readYacdAsset(path, config.yacdRoot);
          if (asset.status !== 200) { json(res, asset.status, { error: asset.status === 503 ? 'Yacd 面板资源不可用' : '未找到资源' }); return; }
          res.writeHead(200, { ...security, 'content-type': asset.type });
          res.end(req.method === 'HEAD' ? undefined : asset.content); return;
        }
        proxyHTTP(req, res, native); return;
      }
      if (path === '/api/overview' && req.method === 'GET') { json(res, 200, await overview()); return; }
      if (path === '/api/tailscale/prefs' && req.method === 'POST') {
        let text = '';
        for await (const chunk of req) {
          text += chunk.toString('utf8');
          if (Buffer.byteLength(text) > 16384) { json(res, 413, { error: '请求体过大' }); return; }
        }
        let patch;
        try { patch = validatePrefs(JSON.parse(text)); } catch { json(res, 400, { error: '仅支持布尔开关与固定 fake-IP 路由' }); return; }
        try {
          const prefs = await requestJSON(ts, '/localapi/v0/prefs', { method: 'PATCH', headers: tsHeaders, body: JSON.stringify(patch) });
          json(res, 200, { ok: true, prefs: prefsView(prefs) });
        } catch { json(res, 502, { error: 'Tailscale 修改失败，未确认生效；请刷新状态核对' }); }
        return;
      }
      const redirects = { '/mihomo': hosts.mihomo, '/mihomo/': hosts.mihomo, '/oxidns': hosts.oxidns, '/oxidns/': hosts.oxidns };
      if (redirects[path] && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(302, { ...security, location: `https://${redirects[path]}/` }); res.end(); return;
      }
      if (path === '/login.js' && ['GET', 'HEAD'].includes(req.method)) { res.writeHead(200, { ...security, 'content-type': 'text/javascript; charset=utf-8' }); res.end(await readFile(new URL('login.js', PUBLIC))); return; }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (files[path] && ['GET', 'HEAD'].includes(req.method)) {
        const [file, type] = files[path];
        const content = await readFile(new URL(file, PUBLIC));
        res.writeHead(200, { ...security, 'content-type': `${type}; charset=utf-8`, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'" });
        res.end(req.method === 'HEAD' ? undefined : content); return;
      }
      json(res, 404, { error: '未找到资源' });
    } catch { if (!res.headersSent) json(res, 500, { error: '请求处理失败' }); else res.destroy(); }
  });
  server.headersTimeout = 20000; server.requestTimeout = 30000; server.keepAliveTimeout = 5000;
  server.on('upgrade', (req, socket, head) => {
    const status = authenticate(req);
    const refuse = code => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (status !== 200) { refuse(status); return; }
    if (!sameOrigin(req)) { refuse(403); return; }
    let proxy;
    try { proxy = findProxy(req, new URL(req.url, 'http://dashboard.invalid').pathname); } catch { refuse(400); return; }
    if (!proxy?.api || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') { refuse(404); return; }
    const upstream = http.request({ ...proxy.target, method: 'GET', path: upstreamPath(req.url, proxy), headers: {
      ...safeHeaders(req.headers), ...(proxy.api ? bearer : proxy.oxidns ? oxidnsAuth : {}), connection: 'Upgrade', upgrade: 'websocket',
    } });
    upstream.setTimeout(5000, () => upstream.destroy());
    socket.on('close', () => upstream.destroy()); socket.on('error', () => upstream.destroy());
    upstream.on('error', () => { if (!socket.destroyed) refuse(502); });
    upstream.on('response', remote => { remote.resume(); refuse(502); });
    upstream.on('upgrade', (remote, tunnel, upstreamHead) => {
      const headers = safeHeaders(remote.headers);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) tunnel.write(head);
      tunnel.on('error', () => socket.destroy()); socket.on('error', () => tunnel.destroy());
      socket.on('close', () => tunnel.destroy()); tunnel.on('close', () => socket.destroy());
      socket.setTimeout(120000, () => socket.destroy()); tunnel.setTimeout(120000, () => tunnel.destroy());
      socket.pipe(tunnel).pipe(socket);
    });
    upstream.end();
  });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const config = await loadConfig();
    createDashboard(config).listen(8080, '0.0.0.0', () => console.log('Dashboard listening on :8080'));
  } catch { console.error('Dashboard startup failed: check credential files and configuration'); process.exitCode = 1; }
}
