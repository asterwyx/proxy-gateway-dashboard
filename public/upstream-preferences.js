// Set native preferences before the upstream application starts. JavaScript,
// CSS and API calls from the upstream are otherwise served unchanged.
(() => {
  'use strict';
  const ui = document.currentScript.dataset.ui;
  const preferences = window.GatewayPreferences;
  let previous = null, pendingLocale = null;

  function store(key, value, notify = false) {
    try {
      const oldValue = localStorage.getItem(key);
      if (oldValue === value) return;
      localStorage.setItem(key, value);
      if (notify) window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: value, storageArea: localStorage, url: location.href }));
    } catch {}
  }
  function changeSelect(values, value) {
    const select = [...document.querySelectorAll('select')].find(element => values.every(option => [...element.options].some(item => item.value === option)));
    if (!select) return false;
    if (select.value !== value) {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;
  }
  function syncOxiDNSLocale() {
    if (!pendingLocale) return;
    const labels = pendingLocale === 'zh' ? ['Switch to Simplified Chinese', '切换到简体中文'] : ['Switch to English', '切换到英文'];
    const opposite = pendingLocale === 'zh' ? ['Switch to English', '切换到英文'] : ['Switch to Simplified Chinese', '切换到简体中文'];
    const button = labels.map(label => document.querySelector(`button[aria-label="${label}"]`)).find(Boolean);
    if (button) { pendingLocale = null; button.click(); }
    else if (opposite.some(label => document.querySelector(`button[aria-label="${label}"]`))) pendingLocale = null;
  }
  function reloadForLanguage(state) {
    // Zashboard reads these keys while starting; preserve navigation and let
    // users finish an open editor/dialog before applying a live change.
    if (!document.querySelector('[role="dialog"], dialog[open], input:focus, textarea:focus, [contenteditable="true"]:focus')) {
      location.reload(); return;
    }
    if (document.getElementById('gateway-language-update')) return;
    const button = document.createElement('button');
    button.id = 'gateway-language-update';
    button.textContent = state.language === 'zh' ? '应用 Dashboard 的语言设置' : 'Apply Dashboard language';
    button.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:12px 18px;border-radius:8px;cursor:pointer';
    button.addEventListener('click', () => location.reload());
    document.body.appendChild(button);
  }
  function apply(state) {
    const language = state.language === 'zh' ? 'zh-CN' : 'en-US';
    if (ui === 'zashboard') {
      const url = new URL(location.href);
      url.searchParams.set('hostname', location.hostname);
      url.searchParams.set('port', location.port || (location.protocol === 'https:' ? '443' : '80'));
      url.searchParams.set('protocol', location.protocol.slice(0, -1));
      url.searchParams.set('secondaryPath', '/mihomo-api');
      url.searchParams.delete('secret');
      if (!previous) {
        store('config/auto-theme', 'false');
        store('config/default-theme', state.theme);
        store('config/dark-theme', 'dark');
        store('config/language', language);
        const backend = { type: 'clash', protocol: location.protocol.slice(0, -1), host: location.hostname,
          port: location.port || '443', secondaryPath: '/mihomo-api', password: '',
          uuid: 'gateway', label: 'Gateway' };
        store('setup/api-list', JSON.stringify([backend]));
        store('setup/active-uuid', backend.uuid);
      }
      history.replaceState(history.state, '', url.href);
      if (previous) {
        store('config/auto-theme', 'false');
        store('config/default-theme', state.theme);
        store('config/language', language);
        if (previous.theme !== state.theme || previous.language !== state.language) reloadForLanguage(state);
      }
    } else if (ui === 'oxidns') {
      store('theme', state.theme, Boolean(previous));
      store('oxidns.locale', state.language === 'zh' ? 'zh-CN' : 'en-US');
      pendingLocale = state.language; syncOxiDNSLocale();
    }
    previous = state;
  }
  if (ui === 'oxidns') new MutationObserver(syncOxiDNSLocale).observe(document.documentElement, { childList: true, subtree: true });
  preferences.subscribe(apply);
})();
