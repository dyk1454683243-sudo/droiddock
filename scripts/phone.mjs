import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, installationId, inspectPort } from './setup.mjs';

// Narrow lifecycle operations for the personal Codex plugin; no raw device commands.
export async function phoneAction(action, options) {
  if (!['open', 'status', 'disconnect'].includes(action)) throw new Error('Choose open, status, or disconnect.');
  const { port, configurationId, inspect = inspectPort, launch, request = fetch } = options;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DroidDock port.');
  const url = `http://127.0.0.1:${port}/`;
  let service = await inspect(port);
  const verify = () => {
    if (service.kind === 'occupied') throw new Error('The configured port belongs to another service or DroidDock installation. Nothing was changed.');
    if (service.kind === 'ours' && service.status.configurationId !== configurationId) throw new Error('Running DroidDock uses different phone settings. Nothing was changed; resolve the configuration before continuing.');
  };
  verify();
  if (service.kind === 'free' && action === 'open') {
    await launch();
    service = await inspect(port);
    verify();
    if (service.kind !== 'ours') throw new Error('DroidDock did not become ready.');
  }
  if (service.kind === 'free') return { running: false, state: 'stopped', url, message: 'DroidDock is stopped. Say "open my phone" to start it.' };
  if (action === 'disconnect') {
    const response = await request(`${url}api/disconnect`, { method: 'POST', headers: { 'X-DroidDock': '1' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) throw new Error('DroidDock did not confirm disconnect. Check status before retrying.');
    service = await inspect(port);
    verify();
    if (service.kind !== 'ours' || service.status.state !== 'idle') throw new Error('Disconnect could not be verified. Check status before retrying.');
  }
  const { state, message, device } = service.status;
  return { running: true, state, message, device, url,
    ...(action === 'open' ? { next: 'Open or reuse DroidDock in the current task right panel. Select Connect if disconnected or opened elsewhere; it transfers control here automatically. Verify rendered phone video.' } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/phone.mjs open|status|disconnect');
    const { config } = await import('../dist/droiddock/config.js');
    const configurationId = createHash('sha256').update(JSON.stringify([config.deviceSerial, config.adb, config.deviceName, config.port])).digest('hex').slice(0, 16);
    const result = await phoneAction(process.argv[2], {
      port: config.port, configurationId,
      inspect: port => inspectPort(port, installationId),
      launch: () => {
        const child = spawnSync(process.execPath, [join(root, 'scripts/launch.mjs')], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
        if (child.error || child.status !== 0) throw new Error('DroidDock startup failed. Check local configuration and launcher logs; command output was withheld to protect local details.');
      },
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
