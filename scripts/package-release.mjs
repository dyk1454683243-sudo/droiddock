import { mkdirSync, existsSync, lstatSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkPublic, entries, git, sha256 } from './check-public.mjs';

export function packageRelease({ cwd = process.cwd(), initialRelease = false, env = process.env } = {}) {
  cwd = resolve(cwd);
  const head = git(cwd, ['rev-parse', '--verify', 'HEAD'])?.toString('utf8').trim();
  // Includes untracked, staged, and unstaged source. Ignored local files never enter git archive.
  if (git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).length) throw new Error('release-requires-clean-committed-head');
  const check = checkPublic({ cwd, initialRelease, canonicalRemotes: true, env });
  if (!check.ok) throw new Error('public-check-failed: ' + check.findings.map(item => `${JSON.stringify(item.path)}:${item.rule}`).join(', '));
  let pkg;
  try { pkg = JSON.parse(git(cwd, ['show', `${head}:package.json`]).toString('utf8')); }
  catch { throw new Error('invalid-release-package-metadata'); }
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('invalid-release-version');
  const name = `droiddock-${pkg.version}-${head.slice(0, 12)}`;
  const prefix = `${name}/`;
  const source = entries(cwd, head);
  // Store mode avoids differences between zlib versions; Git supplies the commit timestamp.
  const archive = git(cwd, ['-c', 'core.attributesFile=', 'archive', '--format=zip', '-0', `--prefix=${prefix}`, head]);
  // Check actual archive bytes against HEAD, including effects of .git/info/attributes.
  const actual = readStoredZip(archive);
  const files = source.map(entry => {
    const data = git(cwd, ['cat-file', 'blob', entry.oid]);
    const archived = actual.get(prefix + entry.path);
    if (!archived || !archived.equals(data)) throw new Error('archive-does-not-match-committed-source');
    actual.delete(prefix + entry.path);
    return { path: entry.path, bytes: data.length, sha256: sha256(data) };
  });
  if (actual.size) throw new Error('archive-has-unexpected-files');
  const manifest = Buffer.from(JSON.stringify({ formatVersion: 1, project: 'DroidDock by Hooware', version: pkg.version, commit: head, archive: `${name}.zip`, files }, null, 2) + '\n');
  const output = join(cwd, 'artifacts', 'releases', name);
  if (git(cwd, ['rev-parse', 'HEAD']).toString('utf8').trim() !== head || git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).length) throw new Error('release-source-changed-during-packaging');
  for (const directory of [join(cwd, 'artifacts'), join(cwd, 'artifacts', 'releases'), output]) {
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('release-output-symlink');
  }
  if (existsSync(output)) throw new Error('release-output-already-exists');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, `${name}.zip`), archive, { flag: 'wx' });
  writeFileSync(join(output, 'manifest.json'), manifest, { flag: 'wx' });
  writeFileSync(join(output, 'SHA256SUMS'), `${sha256(archive)}  ${name}.zip\n${sha256(manifest)}  manifest.json\n`, { flag: 'wx' });
  return { directory: `artifacts/releases/${name}`, commit: head, files: files.length };
}

// Git's uncompressed ZIP output: inspect the central directory and compare every file.
// ZIP64 is intentionally unsupported for this small source release.
export function readStoredZip(zip) {
  let end = zip.length - 22;
  while (end >= Math.max(0, zip.length - 65557) && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) throw new Error('invalid-release-zip');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50 || zip.readUInt16LE(offset + 10) !== 0) throw new Error('unsupported-release-zip');
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!name.endsWith('/')) {
      if (files.has(name) || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('invalid-release-zip-entry');
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      files.set(name, zip.subarray(start, start + size));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--initial-release')) throw new Error('unknown-option');
    console.log(JSON.stringify(packageRelease({ initialRelease: process.argv.includes('--initial-release') }), null, 2));
  } catch (error) {
    // Only controlled error codes are public; filesystem exceptions can expose local paths.
    console.error(error.code ? 'release-filesystem-operation-failed' : error.message);
    process.exitCode = 1;
  }
}
