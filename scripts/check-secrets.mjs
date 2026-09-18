// Job: run a checksum-pinned secret scanner without executing repository hooks.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { entries, git } from './check-public.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = '8.30.1';
const packages = {
  win32: ['windows_x64.zip', 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'],
  linux: ['linux_x64.tar.gz', '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb'],
};
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, windowsHide: true, shell: false, timeout: 120000, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error('Secret verification failed. Review the redacted scanner output.');
}

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--directory')) throw new Error('Usage: node scripts/check-secrets.mjs [--directory exported-source]');
  if (process.arch !== 'x64' || !packages[process.platform]) throw new Error('This helper supports Windows/Linux x64. Run checksum-verified Gitleaks 8.30.1 on other platforms.');
  const [suffix, expected] = packages[process.platform];
  const folder = join(root, '.setup', 'gitleaks', version);
  await mkdir(folder, { recursive: true });
  const archive = join(folder, `gitleaks_${version}_${suffix}`);
  let bytes;
  try { bytes = await readFile(archive); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${suffix}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Could not download the pinned secret scanner.');
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Secret scanner checksum mismatch.');
    await writeFile(archive, bytes);
  }
  // Re-extract the verified package each time; do not trust a cached executable.
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:DROIDDOCK_SCAN_ARCHIVE -DestinationPath $env:DROIDDOCK_SCAN_FOLDER -Force'], {
      env: { ...process.env, DROIDDOCK_SCAN_ARCHIVE: archive, DROIDDOCK_SCAN_FOLDER: folder },
    });
  } else run('tar', ['-xzf', archive, '-C', folder, 'gitleaks']);
  const executable = join(folder, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
  await access(executable);
  // Findings show file/rule information with secret values fully redacted.
  const scan = scanArgs => run(executable, [...scanArgs, '--no-banner', '--redact=100', '--exit-code=1']);
  if (args.length) scan(['dir', resolve(args[1])]);
  else {
    const staged = await mkdtemp(join(tmpdir(), 'droiddock-secret-check-'));
    try {
      // Export index blobs, not working files, so unstaged edits cannot conceal a secret.
      for (const entry of entries(root)) {
        if (!['100644', '100755'].includes(entry.mode) || entry.stage !== '0' ||
            !/^[A-Za-z0-9_.\/-]+$/.test(entry.path) || entry.path.startsWith('/') ||
            entry.path.split('/').some(part => part === '..' || part === '.')) {
          throw new Error('Staged source contains an unsupported path or file type.');
        }
        const target = join(staged, entry.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, git(root, ['cat-file', 'blob', entry.oid]), { flag: 'wx' });
      }
      scan(['dir', staged]);
    } finally { await rm(staged, { recursive: true, force: true }); }
    if (git(root, ['rev-list', '--all']).length) scan(['git', root, '--log-opts=--all']);
  }
} catch (error) {
  console.error(error.code ? 'Secret verification filesystem operation failed.' : error.message);
  process.exitCode = 1;
}
