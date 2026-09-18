// Job: catch broken repository-relative documentation links without network access.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
  if (!files.length) throw new Error('Stage the public source before checking documentation links.');
  const paths = new Set(files);
  const failures = [];
  for (const file of files.filter(file => file.endsWith('.md'))) {
    const text = await readFile(resolve(root, file), 'utf8');
    for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const href = match[1].trim().replace(/^<|>$/g, '').split(/\s+"/)[0];
      if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(href.split(/[?#]/)[0])));
      if (target.startsWith('../') || (!paths.has(target) && !files.some(path => path.startsWith(`${target.replace(/\/$/, '')}/`)))) failures.push(`${file}: missing repository link target`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`Documentation links passed (${files.filter(file => file.endsWith('.md')).length} Markdown files).`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
