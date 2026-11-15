import { translate } from './i18n.js';
const $ = id => document.getElementById(id);
const preferences = window.GatewayPreferences;
let t = translate(preferences.get().language);
const params = new URLSearchParams(location.search);
// Keep only a same-origin relative destination. The server re-validates it.
const next = params.get('next');
if (next && next.startsWith('/') && !next.startsWith('//')) $('next').value = next;
if (params.get('error')) $('login-error').hidden = false;
const pw = $('password'), reveal = $('toggle-password');
function updateReveal() {
  const hidden = pw.type === 'password';
  reveal.textContent = t(hidden ? 'show' : 'hide');
  reveal.setAttribute('aria-label', t(hidden ? 'show' : 'hide'));
  reveal.setAttribute('aria-pressed', String(!hidden));
}
updateReveal();
preferences.subscribe(state => {
  t = translate(state.language);
  $('lang').value = state.languageMode; $('theme').value = state.themeMode;
  updateReveal();
});
$('lang').addEventListener('change', () => preferences.set({ language: $('lang').value }));
$('theme').addEventListener('change', () => preferences.set({ theme: $('theme').value }));
reveal.addEventListener('click', () => {
  pw.type = pw.type === 'password' ? 'text' : 'password';
  updateReveal();
  pw.focus();
});
