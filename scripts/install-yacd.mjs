import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pin = JSON.parse(await readFile(join(root, 'frontend/yacd.json'), 'utf8'));
const destination = join(root, 'vendor/yacd');
if (!/^[a-f0-9]{40}$/.test(pin.revision)) throw new Error('Invalid Yacd revision');

async function install() {
  let existing;
  try {
    existing = (await readFile(join(destination, '.gateway-revision'), 'utf8')).trim();
    if (existing === pin.revision) {
      await access(join(destination, 'index.html'));
      console.log(`Yacd already installed: ${pin.revision}`); return;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try {
    await access(destination);
    if (!existing || !/^[a-f0-9]{40}$/.test(existing)) throw new Error('Refusing to replace a directory not created by this installer');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--source')) throw new Error('Usage: node scripts/install-yacd.mjs [--source <local-git-directory>]');
  await mkdir(join(root, 'vendor'), { recursive: true });
  // Stage beside the destination so the final rename also works when /tmp
  // and the checkout are mounted on different filesystems.
  const temporary = await mkdtemp(join(root, 'vendor/.yacd-install-'));
  try {
    const repository = args.length ? resolve(args[1]) : join(temporary, 'repository');
    const git = (...arguments_) => execFileSync('git', ['-C', repository, ...arguments_], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    if (!args.length) {
      await mkdir(repository);
      git('init');
      git('fetch', '--depth=1', pin.repository, pin.revision);
    }
    const archive = git('archive', '--format=tar', pin.revision);
    if (createHash('sha256').update(archive).digest('hex') !== pin.archiveSha256) throw new Error('Yacd archive checksum does not match the pinned release');
    const archivePath = join(temporary, 'yacd.tar'), extracted = join(temporary, 'extracted');
    await writeFile(archivePath, archive); await mkdir(extracted);
    execFileSync('tar', ['-xf', archivePath, '-C', extracted], { stdio: 'pipe' });
    await access(join(extracted, 'index.html'));
    await writeFile(join(extracted, '.gateway-revision'), pin.revision + '\n');
    if (existing) await rm(destination, { recursive: true });
    await rename(extracted, destination);
    console.log(`Installed official Yacd assets: ${pin.revision}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
await install();
