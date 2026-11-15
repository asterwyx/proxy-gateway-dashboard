export function injectPreferences(html, ui) {
  const scripts = `<script src="/_gateway/preferences.js"></script><script src="/_gateway/upstream-preferences.js" data-ui="${ui}"></script>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, head => head + scripts);
  return html.replace(/^(\s*<!doctype[^>]*>)?/i, start => start + scripts);
}
