import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboard, HOSTS, sessionCookie } from '../server.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeOxiScript = `let locale=localStorage.getItem('oxidns.locale')||'zh-CN';
const toggle=document.getElementById('language');
function render(){document.documentElement.lang=locale;document.querySelector('h1').textContent=locale==='zh-CN'?'解析控制台':'DNS Console';toggle.setAttribute('aria-label',locale==='zh-CN'?'切换到英文':'Switch to Simplified Chinese');toggle.textContent=locale==='zh-CN'?'EN':'中文';}
function theme(){document.documentElement.classList.toggle('dark',localStorage.getItem('theme')==='dark');}
toggle.onclick=()=>{locale=locale==='zh-CN'?'en-US':'zh-CN';localStorage.setItem('oxidns.locale',locale);render();};
addEventListener('storage',event=>{if(event.key==='theme')theme();});render();theme();`;
const nativeOxiHTML = '<!doctype html><html><head><meta charset="utf-8"><title>OxiDNS</title><style>body{background:white;color:#111}.dark body{background:#111;color:white}</style><script defer src="/native-oxidns.js"></script></head><body><h1></h1><button id="language"></button></body></html>';
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

async function listen(server, socket) {
  const connections = new Set();
  server.on('connection', connection => { connections.add(connection); connection.on('close', () => connections.delete(connection)); });
  await new Promise(resolve => socket ? server.listen(socket, resolve) : server.listen(0, '127.0.0.1', resolve));
  return { target: socket ? { socketPath: socket } : { hostname: '127.0.0.1', port: server.address().port },
    close: async () => { for (const connection of connections) connection.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

export async function verifyBrowser(options = {}) {
  const { chromium } = await import(options.playwrightModule || process.env.PLAYWRIGHT_MODULE || 'playwright');
  const temporary = await mkdtemp(join(tmpdir(), 'gateway-browser-')), services = [];
  const group = '策略组 #1 / 主入口', candidate = '香港 / 自动节点组';
  let selected = 'DIRECT', switched = 0, browser;
  try {
    const proxy = (name, type, extra = {}) => ({ name, type, history: [], udp: true, ...extra });
    const mihomo = http.createServer(async (req, res) => {
      if (req.url === '/version') json(res, { version: 'v1.19.34', meta: true });
      else if (req.url === '/configs') json(res, { mode: 'rule', 'log-level': 'info', port: 7890, 'socks-port': 7891, 'allow-lan': false, tun: { enable: true } });
      else if (req.url === '/proxies') json(res, { proxies: {
        DIRECT: proxy('DIRECT', 'Direct'), REJECT: proxy('REJECT', 'Reject'),
        [group]: proxy(group, 'Selector', { now: selected, all: ['DIRECT', candidate] }),
        [candidate]: proxy(candidate, 'Selector', { now: 'DIRECT', all: ['DIRECT'] }),
      } });
      else if (req.url === '/providers/proxies') json(res, { providers: {} });
      else if (req.url === '/connections' && req.method === 'GET') json(res, { connections: [], uploadTotal: 0, downloadTotal: 0 });
      else if (req.url === '/proxies/' + encodeURIComponent(group) && req.method === 'PUT') {
        assert.equal(req.headers.authorization, 'Bearer test-secret');
        let text = ''; for await (const chunk of req) text += chunk;
        selected = JSON.parse(text).name; switched++;
        res.writeHead(204); res.end();
      } else if (req.method === 'DELETE') { res.writeHead(204); res.end(); }
      else json(res, {});
    });
    mihomo.on('upgrade', (req, socket) => {
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const message = Buffer.from(JSON.stringify(req.url.startsWith('/memory') ? { inuse: 0, oslimit: 0 } : { up: 0, down: 0 }));
      socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
    });
    const m = await listen(mihomo); services.push(m);
    const oxi = await listen(http.createServer((req, res) => {
      if (req.url === '/native-oxidns.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(nativeOxiScript); }
      else if (req.url === '/api/health') json(res, { version: 'browser-fixture' });
      else if (req.url === '/api/readyz') { res.writeHead(200); res.end('ready'); }
      else if (req.url.startsWith('/api/')) json(res, {});
      else { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(nativeOxiHTML); }
    })); services.push(oxi);
    const ts = await listen(http.createServer((req, res) => json(res, req.url.endsWith('/status') ? { BackendState: 'Running', Self: { HostName: 'browser-test', Online: true }, Peer: {} } : { WantRunning: true, ShieldsUp: false, AdvertiseRoutes: [] })), join(temporary, 'ts.sock')); services.push(ts);
    const board = await listen(createDashboard({ user: 'test', password: 'test-password', secret: 'test-secret', mihomo: m.target,
      oxidns: options.oxidnsTarget || oxi.target, oxidnsPassword: options.oxidnsPassword || 'test-dns-password', tsSocket: ts.target.socketPath })); services.push(board);
    browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP *.proxy.asterwyx.top 127.0.0.1'] });
    const context = await browser.newContext({ locale: 'en-US', colorScheme: 'dark', viewport: { width: 1440, height: 1000 } });
    const errors = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const address = host => `http://${host}:${board.target.port}`;
    const dashboard = await context.newPage(); await dashboard.goto(address(HOSTS.dashboard) + '/login');
    await dashboard.waitForFunction(() => document.documentElement.lang === 'en' && document.documentElement.dataset.theme === 'dark');
    assert.equal(await dashboard.locator('#lang').inputValue(), 'system'); assert.equal(await dashboard.locator('#theme').inputValue(), 'system');
    const cookie = sessionCookie('test-password').split(';')[0].slice('gateway_session='.length);
    await context.addCookies([{ name: 'gateway_session', value: cookie, domain: '.proxy.asterwyx.top', path: '/', httpOnly: true, secure: false, sameSite: 'Strict' }]);
    await dashboard.goto(address(HOSTS.dashboard) + '/');
    await dashboard.waitForFunction(() => document.querySelector('#mihomo-status')?.textContent.includes('Available'));
    const yacd = await context.newPage(); await yacd.goto(address(HOSTS.mihomo) + '/');
    await yacd.waitForFunction(() => [...document.querySelectorAll('a')].some(link => link.getAttribute('href')?.endsWith('/proxies')));
    const oxidns = await context.newPage(); await oxidns.goto(address(HOSTS.oxidns) + '/');
    await oxidns.locator('button[aria-label="Switch to Simplified Chinese"]').waitFor();
    await oxidns.waitForFunction(() => document.documentElement.classList.contains('dark'));
    const oxiURL = oxidns.url();
    await dashboard.selectOption('#theme', 'light'); await dashboard.selectOption('#lang', 'zh');
    await dashboard.waitForFunction(() => document.querySelector('#mihomo-status').textContent.includes('可用'));
    await oxidns.bringToFront(); await oxidns.locator('button[aria-label="切换到英文"]').waitFor();
    await oxidns.waitForFunction(() => !document.documentElement.classList.contains('dark'));
    assert.equal(oxidns.url(), oxiURL);
    await yacd.bringToFront();
    await yacd.waitForFunction(() => document.documentElement.dataset.theme === 'light' && [...document.querySelectorAll('a')].some(link => link.getAttribute('href')?.endsWith('/proxies') && link.textContent.includes('代理')));
    await yacd.locator('a[href$="/proxies"]').click();
    const switchResponse = yacd.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/mihomo-api/proxies/' + encodeURIComponent(group));
    await yacd.getByRole('menuitem', { name: candidate }).first().click();
    assert.equal((await switchResponse).status(), 204);
    assert.equal(selected, candidate); assert.equal(switched, 1);
    await yacd.reload();
    await yacd.waitForFunction(name => document.body.textContent.includes(name), candidate);
    assert.equal(selected, candidate);
    const artifacts = join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
    await dashboard.screenshot({ path: join(artifacts, 'dashboard-zh-light.png'), fullPage: true });
    await yacd.screenshot({ path: join(artifacts, 'yacd-zh-light.png'), fullPage: true });
    if (options.oxidnsTarget) await oxidns.screenshot({ path: join(artifacts, 'oxidns-zh-light.png'), fullPage: true });
    await dashboard.selectOption('#lang', 'en'); await dashboard.selectOption('#theme', 'dark');
    await yacd.bringToFront(); await yacd.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && [...document.querySelectorAll('a')].some(link => link.getAttribute('href')?.endsWith('/proxies') && link.textContent.includes('Proxies')));
    await oxidns.bringToFront(); await oxidns.locator('button[aria-label="Switch to Simplified Chinese"]').waitFor(); await oxidns.waitForFunction(() => document.documentElement.classList.contains('dark'));
    await dashboard.selectOption('#theme', 'system'); await dashboard.emulateMedia({ colorScheme: 'light' });
    await dashboard.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await dashboard.setViewportSize({ width: 390, height: 844 });
    assert(await dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: automatic defaults, shared appearance, native locale updates, Yacd node-group selection and mobile layout.');
  } finally {
    if (browser) await browser.close();
    for (const service of services.reverse()) await service.close();
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await verifyBrowser();
