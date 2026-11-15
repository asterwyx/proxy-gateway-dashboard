// Shared, non-sensitive appearance preferences. Authentication uses a separate
// HttpOnly cookie; this cookie never contains credentials or backend settings.
(() => {
  'use strict';
  const cookieName = 'gateway_preferences';
  const cookieDomain = 'proxy.asterwyx.top';
  const defaults = { theme: 'system', language: 'system' };
  const themes = ['system', 'light', 'dark'], languages = ['system', 'zh', 'en'];
  const media = matchMedia('(prefers-color-scheme: dark)');
  const listeners = new Set();
  let fallback = null, last = '';

  function read() {
    if (fallback) return fallback;
    try {
      const value = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
      if (!value) return fallback || defaults;
      const parsed = JSON.parse(decodeURIComponent(value.slice(cookieName.length + 1)));
      return { theme: themes.includes(parsed?.theme) ? parsed.theme : 'system', language: languages.includes(parsed?.language) ? parsed.language : 'system' };
    } catch { return fallback || defaults; }
  }
  function browserLanguage() {
    for (const language of navigator.languages?.length ? navigator.languages : [navigator.language]) {
      if (/^zh(?:-|$)/i.test(language)) return 'zh';
      if (/^en(?:-|$)/i.test(language)) return 'en';
    }
    return 'en';
  }
  function get() {
    const settings = read();
    return { themeMode: settings.theme, languageMode: settings.language,
      theme: settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : settings.theme,
      language: settings.language === 'system' ? browserLanguage() : settings.language };
  }
  function notify() {
    const current = get(), signature = JSON.stringify(current);
    if (last === signature) return;
    last = signature;
    document.documentElement.dataset.theme = current.theme;
    document.documentElement.lang = current.language === 'zh' ? 'zh-CN' : 'en';
    for (const listener of listeners) listener(current);
  }
  function set(update) {
    const settings = { ...read() };
    if (themes.includes(update.theme)) settings.theme = update.theme;
    if (languages.includes(update.language)) settings.language = update.language;
    const value = encodeURIComponent(JSON.stringify(settings));
    const domain = location.hostname === cookieDomain || location.hostname.endsWith(`.${cookieDomain}`) ? `; Domain=${cookieDomain}` : '';
    try {
      document.cookie = `${cookieName}=${value}; Path=/; Max-Age=31536000; SameSite=Strict${domain}${location.protocol === 'https:' ? '; Secure' : ''}`;
      // Keep controls usable when browser policy blocks cookies altogether.
      fallback = document.cookie.split(';').some(part => part.trim() === `${cookieName}=${value}`) ? null : settings;
    } catch { fallback = settings; }
    notify();
  }
  function subscribe(listener) {
    listeners.add(listener);
    listener(get());
    return () => listeners.delete(listener);
  }
  window.GatewayPreferences = Object.freeze({ get, set, subscribe });
  media.addEventListener('change', notify);
  for (const event of ['languagechange', 'focus', 'pageshow']) window.addEventListener(event, notify);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) notify(); });
  // Cookies cross subdomains, whereas localStorage/storage events do not.
  setInterval(() => { if (!document.hidden) notify(); }, 1000);
  notify();
})();
