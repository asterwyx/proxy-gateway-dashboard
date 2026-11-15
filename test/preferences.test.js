import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/preferences.js', import.meta.url), 'utf8');
function browser({ jar = new Map(), language = 'en-US', dark = false, hostname = 'board.proxy.asterwyx.top', blockWrites = false } = {}) {
  const window = new EventTarget(), document = new EventTarget(), media = new EventTarget();
  document.documentElement = { dataset: {}, lang: '' }; document.hidden = false;
  const navigator = { language, languages: [language] }, writes = [];
  media.matches = dark;
  Object.defineProperty(document, 'cookie', {
    get: () => [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
    set: value => {
      writes.push(value); if (blockWrites) return;
      const [pair] = value.split(';'), equals = pair.indexOf('='); jar.set(pair.slice(0, equals), pair.slice(equals + 1));
    },
  });
  runInNewContext(script, { window, document, navigator, location: { hostname, protocol: 'https:' }, matchMedia: () => media, setInterval: () => 0 });
  return { window, document, media, navigator, writes, preferences: window.GatewayPreferences };
}

test('fresh pages follow browser language and live color-scheme changes without persisting an automatic choice', () => {
  const page = browser({ language: 'zh-CN', dark: true });
  assert.equal(page.preferences.get().language, 'zh'); assert.equal(page.preferences.get().languageMode, 'system');
  assert.equal(page.document.documentElement.dataset.theme, 'dark'); assert.equal(page.writes.length, 0);
  page.media.matches = false; page.media.dispatchEvent(new Event('change'));
  assert.equal(page.document.documentElement.dataset.theme, 'light');
  page.navigator.languages = ['en-US']; page.window.dispatchEvent(new Event('languagechange'));
  assert.equal(page.document.documentElement.lang, 'en'); assert.equal(page.writes.length, 0);
});
test('explicit choices survive browser changes and system mode resumes following the current browser', () => {
  const page = browser({ dark: true });
  page.preferences.set({ language: 'zh', theme: 'light' });
  page.navigator.languages = ['en-US']; page.media.matches = true; page.media.dispatchEvent(new Event('change'));
  assert.equal(page.preferences.get().language, 'zh'); assert.equal(page.preferences.get().theme, 'light');
  page.preferences.set({ language: 'system', theme: 'system' });
  assert.equal(page.preferences.get().language, 'en'); assert.equal(page.preferences.get().theme, 'dark');
});
test('appearance travels across subdomains on focus while the authentication cookie is preserved', () => {
  const jar = new Map([['gateway_session', 'opaque-session']]);
  const board = browser({ jar }), child = browser({ jar, hostname: 'oxidns.proxy.asterwyx.top' });
  board.preferences.set({ theme: 'dark', language: 'zh' });
  assert(board.writes[0].includes('Domain=proxy.asterwyx.top')); assert(board.writes[0].includes('; Secure'));
  child.window.dispatchEvent(new Event('focus'));
  assert.equal(child.document.documentElement.dataset.theme, 'dark'); assert.equal(child.document.documentElement.lang, 'zh-CN');
  assert.equal(jar.get('gateway_session'), 'opaque-session');
});
test('invalid appearance cookies fall back safely and blocked writes keep controls usable', () => {
  for (const value of ['%not-json', encodeURIComponent('{"theme":"wrong","language":"xx"}'), encodeURIComponent('null')]) {
    const page = browser({ jar: new Map([['gateway_preferences', value]]) });
    assert.equal(page.preferences.get().themeMode, 'system'); assert.equal(page.preferences.get().languageMode, 'system');
  }
  const page = browser({ blockWrites: true, jar: new Map([['gateway_preferences', encodeURIComponent('{"theme":"dark","language":"zh"}')]]) });
  page.preferences.set({ theme: 'light', language: 'en' });
  assert.equal(page.preferences.get().theme, 'light'); assert.equal(page.preferences.get().language, 'en');
});
