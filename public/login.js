import { detectLang, setLang, translate } from './i18n.js';
const $ = id => document.getElementById(id);
const systemDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
let lang = setLang(detectLang());
let t = translate(lang);
$('lang').textContent = lang === 'zh' ? 'EN' : '中文';
$('lang').addEventListener('click', () => {
  lang = setLang(lang === 'zh' ? 'en' : 'zh');
  t = translate(lang);
  $('lang').textContent = lang === 'zh' ? 'EN' : '中文';
  updateReveal();
});
try { const saved = localStorage.getItem('gateway-theme'); if (['light', 'dark'].includes(saved)) document.documentElement.dataset.theme = saved; } catch {}
$('theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : systemDark();
  const next = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = next;
  try { localStorage.setItem('gateway-theme', next); } catch {}
});
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
reveal.addEventListener('click', () => {
  pw.type = pw.type === 'password' ? 'text' : 'password';
  updateReveal();
  pw.focus();
});
