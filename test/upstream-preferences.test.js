import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/upstream-preferences.js', import.meta.url), 'utf8');

function bootstrap() {
  const storage = new Map(), listeners = [];
  const document = { currentScript: { dataset: { ui: 'zashboard' } }, documentElement: {}, querySelector: () => null,
    getElementById: () => null, addEventListener() {}, body: { appendChild() {} } };
  const window = new EventTarget();
  const location = { href: 'https://mihomo.proxy.asterwyx.top/', hostname: 'mihomo.proxy.asterwyx.top', port: '', protocol: 'https:' };
  window.GatewayPreferences = { subscribe(callback) { listeners.push(callback); callback({ theme: 'dark', language: 'zh' }); } };
  runInNewContext(script, { window, document, location, localStorage: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
  history: { state: null, replaceState(_state, _title, href) { location.href = String(href); } },
  URL, StorageEvent: class extends Event {}, console });
  return { storage, listeners, location };
}

test('Zashboard starts with the Dashboard appearance and fixed same-origin API', () => {
  const { storage, listeners, location } = bootstrap();
  assert.equal(storage.get('config/auto-theme'), 'false');
  assert.equal(storage.get('config/default-theme'), 'dark');
  assert.equal(storage.get('config/dark-theme'), 'dark');
  assert.equal(storage.get('config/language'), 'zh-CN');
  assert.deepEqual(JSON.parse(storage.get('setup/api-list')), [{ type: 'clash', protocol: 'https',
    host: 'mihomo.proxy.asterwyx.top', port: '443', secondaryPath: '/mihomo-api', password: '',
    uuid: 'gateway', label: 'Gateway' }]);
  assert.equal(storage.get('setup/active-uuid'), 'gateway');
  assert.match(location.href, /secondaryPath=%2Fmihomo-api/);
  assert.equal(listeners.length, 1);
});
