import { detectLang, setLang, translate } from './i18n.js';
const $ = id => document.getElementById(id);
const CIDR = '198.20.0.0/16';
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
let lang = setLang(detectLang()), t = translate(lang), lastOverview = null;
const locale = () => lang === 'zh' ? 'zh-CN' : 'en-US';
const languageButton = () => { $('lang').textContent = lang === 'zh' ? 'EN' : '中文'; $('lang').setAttribute('aria-label', t('language')); };
let currentPrefs = null, busy = false, loading = false, pending = null;
const text = (id, value) => { $(id).textContent = value; };
const bytes = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ['—', ''];
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let index = 0; while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return [value.toLocaleString(locale(), { maximumFractionDigits: index ? 1 : 0 }), units[index]];
};
function metric(id, value) {
  const [number, unit] = bytes(value), small = document.createElement('small');
  $(id).textContent = number; small.textContent = unit; $(id).append(small);
}
function badge(ok, label) {
  const span = document.createElement('span'); span.className = `status ${ok ? 'good' : 'bad'}`;
  const dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
  span.append(dot, label); return span;
}
function notice(message = '') { text('notice', message); $('notice').hidden = !message; }
function controls() {
  for (const key of ['WantRunning', 'ShieldsUp', 'AdvertiseRoutes']) {
    const value = key === 'AdvertiseRoutes' ? currentPrefs?.AdvertiseRoutes?.includes(CIDR) : currentPrefs?.[key];
    $(key).setAttribute('aria-checked', String(value === true));
    $(key).disabled = busy || !currentPrefs || (key !== 'AdvertiseRoutes' && typeof value !== 'boolean');
  }
  const extra = currentPrefs?.AdvertiseRoutes?.filter(route => route !== CIDR) || [];
  $('route-warning').hidden = !extra.length;
  text('route-warning', t('routeWarning', { routes: extra.join(lang === 'zh' ? '、' : ', ') }));
  text('prefs-note', busy ? t('prefsBusy') : currentPrefs ? t('prefsNote') : t('prefsUnavailable'));
}
function nodes(ts) {
  const peers = ts.peers === null || ts.peers === undefined ? null : [ts.self && { ...ts.self, self: true }, ...ts.peers].filter(Boolean);
  const body = $('nodes-body'); body.replaceChildren();
  text('node-count', peers ? t('nodeCount', { count: peers.length }) : t('nodesUnavailable'));
  text('online', peers ? String(peers.filter(peer => peer.online).length) : t('notAvailable'));
  if (!peers?.length) {
    const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 6; cell.className = 'empty';
    cell.textContent = peers ? t('noNodes') : t('nodesUnavailable'); row.append(cell); body.append(row); return;
  }
  peers.sort((a, b) => Number(!!b.self) - Number(!!a.self) || Number(b.online) - Number(a.online) || String(a.name || '').localeCompare(String(b.name || ''), locale()));

  for (const peer of peers) {
    const row = document.createElement('tr'), nameCell = document.createElement('td');
    const name = document.createElement('span'); name.className = 'node-name'; name.textContent = peer.name || t('unnamed'); nameCell.append(name);
    if (peer.self) { const label = document.createElement('span'); label.className = 'self-label'; label.textContent = t('self'); nameCell.append(label); }
    if (peer.dnsName) { const sub = document.createElement('span'); sub.className = 'node-sub'; sub.textContent = peer.dnsName; nameCell.append(sub); }
    row.append(nameCell);
    const ip = document.createElement('td'); ip.textContent = peer.ips.join(' / ') || t('notAvailable'); row.append(ip);
    const state = document.createElement('td'); state.append(badge(peer.online, peer.online ? t('online') : t('offline'))); row.append(state);
    const lastSeen = peer.online ? t('currentOnline') : peer.lastSeen && !peer.lastSeen.startsWith('0001-') ? new Date(peer.lastSeen).toLocaleString(locale()) : t('notAvailable');
    for (const value of [peer.os || t('notAvailable'), lastSeen, `${bytes(peer.rxBytes).join(' ')} / ${bytes(peer.txBytes).join(' ')}`]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    body.append(row);
  }
}
async function refresh() {
  if (loading || busy || $('confirm').open) return;
  loading = true; $('refresh').disabled = true;
  try {
    const response = await fetch('/api/overview', { cache: 'no-store' });
    if (!response.ok) throw new Error(response.status === 401 ? t('authExpired') : response.status === 429 ? t('tooMany') : t('panelUnavailable'));
    const data = await response.json(), services = data.services, ts = services.tailscale;
    text('connections', services.mihomo.connections ?? t('notAvailable'));
    metric('download', services.mihomo.downloadBytes); metric('upload', services.mihomo.uploadBytes);
    text('mihomo-version', services.mihomo.version ? `mihomo · ${services.mihomo.version}` : `mihomo · ${t('notAvailable')}`);
    text('tailnet', ts.tailnet ? `${ts.tailnet} · ${t('self')}` : t('tailnetUnavailable'));
    for (const key of ['mihomo', 'oxidns', 'tailscale']) {
      const element = $(`${key}-status`), next = badge(services[key].ok, services[key].ok ? t('available') : t('partial'));
      element.className = next.className; element.replaceChildren(...next.childNodes);
    }
    text('oxidns-probe', services.oxidns.ok ? t('oxidnsDesc') : (services.oxidns.error || t('statusUnknown')));
    text('tailscale-state', ts.state ? t('localState', { state: ts.state }) : t('daemonUnreachable'));
    currentPrefs = ts.prefs || null; lastOverview = data; controls(); nodes(ts);
    text('updated', `${t('updated')} ${new Date(data.updatedAt).toLocaleTimeString(locale())}`);
    const errors = Object.entries(services).filter(([, service]) => !service.ok).map(([name, service]) => `${name}${lang === 'zh' ? '：' : ': '}${service.error || t('errorStatus')}`);
    if (ts.health?.length) errors.push(t('tsNotice', { items: ts.health.join(lang === 'zh' ? '；' : '; ') }));
    notice(errors.length ? `${t('partialNotice')} ${errors.join(' · ')}` : '');
  } catch (error) { notice(`${error.message} ${t('staleNotice')}`); text('updated', t('refreshFailed')); currentPrefs = null; controls(); }
  finally { loading = false; $('refresh').disabled = false; }
}
for (const key of ['WantRunning', 'ShieldsUp', 'AdvertiseRoutes']) $(key).addEventListener('click', () => {
  if (!currentPrefs || busy) return;
  const enabled = $(key).getAttribute('aria-checked') !== 'true';
  pending = { [key]: key === 'AdvertiseRoutes' ? (enabled ? [CIDR] : []) : enabled };
  const action = t(enabled ? 'actionEnable' : 'actionDisable');
  const target = t({ WantRunning: 'actWantRunning', ShieldsUp: 'actShieldsUp', AdvertiseRoutes: 'actAdvertise' }[key]);
  text('confirm-title', t('confirmTitle', { action: lang === 'zh' ? action + target : action + ' ' + target }));
  text('confirm-description', t({
    WantRunning: enabled ? 'enableWantRunning' : 'disableWantRunning',
    ShieldsUp: enabled ? 'enableShields' : 'disableShields',
    AdvertiseRoutes: enabled ? 'enableRoutes' : 'disableRoutes',
  }[key], { cidr: CIDR })); $('confirm').returnValue = ''; $('confirm').showModal();
});
$('confirm').addEventListener('close', async () => {
  if ($('confirm').returnValue !== 'apply' || !pending) { pending = null; return; }
  busy = true; controls();
  try {
    const response = await fetch('/api/tailscale/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard-Request': '1' }, body: JSON.stringify(pending) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || t('opFailed'));
    currentPrefs = data.prefs; notice(t('prefsUpdated'));
  } catch (error) { notice(error.message); currentPrefs = null; }
  finally { pending = null; busy = false; controls(); }
});
try { const saved = localStorage.getItem('gateway-theme'); if (['light', 'dark'].includes(saved)) document.documentElement.dataset.theme = saved; } catch {}
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : systemDark();
  const next = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = next;
  try { localStorage.setItem('gateway-theme', next); } catch {}
});
// Logout uses the guarded POST route, then clears this page's cached state.
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try {
    await fetch('/logout', { method: 'POST', headers: { 'X-Dashboard-Request': '1' } });
  } finally { location.replace('/login'); }
});
languageButton();
$('lang').addEventListener('click', () => {
  lang = setLang(lang === 'zh' ? 'en' : 'zh');
  t = translate(lang); languageButton();
  // Re-render data-driven values in the newly selected language.
  if (lastOverview) { controls(); nodes(lastOverview.services.tailscale); text('updated', `${t('updated')} ${new Date(lastOverview.updatedAt).toLocaleTimeString(locale())}`); }
  else controls();
});
// Each upstream UI runs unchanged at its own subdomain root.
$('mihomo-link').href = 'https://mihomo.proxy.asterwyx.top/';
$('refresh').addEventListener('click', refresh);
void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
