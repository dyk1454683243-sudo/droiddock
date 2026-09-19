import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { root, installationId, inspectPort } from './setup.mjs';
import { configurationFingerprintFromConfig } from './video-quality.mjs';

try {
  const { config } = await import('../dist/droiddock/config.js');
  const port = config.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DroidDock port.');
  const current = await inspectPort(port);
  if (current.kind === 'occupied') throw new Error('Port occupied by another service or checkout. Run Install-DroidDock.ps1 to choose a free port.');
  const configurationId = configurationFingerprintFromConfig(config);
  if (current.kind === 'ours' && current.status.configurationId !== configurationId) throw new Error('Running DroidDock has different configuration. Close its phone tab and rerun Install-DroidDock.ps1.');
  if (current.kind === 'free') {
    const logRoot = join(process.env.LOCALAPPDATA ?? join(root, '.setup'), 'DroidDock', installationId);
    mkdirSync(logRoot, { recursive: true });
    const stdout = openSync(join(logRoot, 'server.log'), 'a');
    const stderr = openSync(join(logRoot, 'server-error.log'), 'a');
    let child;
    try {
      child = spawn(process.execPath, [join(root, 'dist/droiddock/server.js')], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr] });
    } finally { closeSync(stdout); closeSync(stderr); }
    let failed = false;
    child.on('error', () => { failed = true; });
    child.unref();
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (failed || child.exitCode !== null) break;
      if ((await inspectPort(port)).kind === 'ours') { ready = true; break; }
      await delay(150);
    }
    if (!ready) throw new Error(`DroidDock did not become ready. Inspect ${logRoot}.`);
  }
  console.log(`http://127.0.0.1:${port}/`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
