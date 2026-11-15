import { readFile } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const YACD_ROOT = fileURLToPath(new URL('./vendor/yacd/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };

export function injectPreferences(html, ui) {
  const scripts = `<script src="/_gateway/preferences.js"></script><script src="/_gateway/upstream-preferences.js" data-ui="${ui}"></script>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, head => head + scripts);
  return html.replace(/^(\s*<!doctype[^>]*>)?/i, start => start + scripts);
}

export async function readYacdAsset(path, root = YACD_ROOT) {
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return { status: 400 }; }
  if (decoded.includes('\\') || decoded.includes('\0')) return { status: 400 };
  const directory = resolve(root), file = resolve(directory, '.' + (decoded.endsWith('/') ? decoded + 'index.html' : decoded));
  const inside = relative(directory, file);
  if (inside === '..' || inside.startsWith('../') || inside.startsWith('..\\')) return { status: 404 };
  try {
    const buffer = await readFile(file), type = types[extname(file)] || 'application/octet-stream';
    const content = type === 'text/html' ? Buffer.from(injectPreferences(buffer.toString('utf8'), 'yacd')) : buffer;
    return { status: 200, type: `${type}${/^(text\/|application\/json)/.test(type) ? '; charset=utf-8' : ''}`, content };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return { status: decoded === '/' ? 503 : 404 };
    throw error;
  }
}
