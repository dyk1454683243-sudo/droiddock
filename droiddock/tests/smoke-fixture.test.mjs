import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import {
  SYNTHETIC_DECODER_MARKER,
  SYNTHETIC_DECODER_PRELUDE,
  SYNTHETIC_DEVICE,
  SYNTHETIC_EVIDENCE,
  SYNTHETIC_FRAME_LABEL,
  startSmokeFixture,
  videoPacket,
} from '../../scripts/smoke-fixture.mjs';

const fixtureSource = readFileSync(new URL('../../scripts/smoke-fixture.mjs', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

async function until(check, description, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test('browser smoke stays out of the shipped runtime and the fast unit suite', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test droiddock/tests/*.test.mjs');
  assert.equal(pkg.scripts.verify.includes('test:smoke'), false);
  assert.equal(pkg.scripts['test:smoke'], 'node scripts/browser-smoke.mjs');
  assert.ok(pkg.devDependencies.playwright);
  assert.equal(pkg.dependencies.playwright, undefined);
  assert.doesNotMatch(readFileSync(new URL('../../scripts/browser-smoke.mjs', import.meta.url), 'utf8'), /retries:\s*[1-9]/);
});

test('synthetic fixture stays local, labeled, and free of phone or ADB hooks', () => {
  assert.match(SYNTHETIC_DECODER_PRELUDE, new RegExp(SYNTHETIC_DECODER_MARKER));
  assert.match(SYNTHETIC_DECODER_PRELUDE, new RegExp(SYNTHETIC_FRAME_LABEL));
  assert.match(SYNTHETIC_DECODER_PRELUDE, /Not Android video/);
  assert.match(SYNTHETIC_DECODER_PRELUDE, /Not H\.264 evidence/);
  assert.equal(SYNTHETIC_DEVICE, 'Synthetic fixture (not a phone)');
  assert.doesNotMatch(appSource, new RegExp(SYNTHETIC_DECODER_MARKER));
  assert.doesNotMatch(appSource, /__DROIDDOCK_STREAM_EVIDENCE__/);
  assert.doesNotMatch(fixtureSource, /\bspawn\b|\bexecFile\b|\badb\b|\bscrcpy\b/i);
  const packet = videoPacket({ config: true });
  assert.equal(new DataView(packet).getUint32(8), packet.byteLength - 12);
});

test('fixture serves public assets with a labeled decoder prelude and rejects foreign hosts', { timeout: 10000 }, async () => {
  const fixture = await startSmokeFixture();
  try {
    const page = await fetch(fixture.origin);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await page.text(), /id="screen"/);

    const source = await (await fetch(`${fixture.origin}/app.js`)).text();
    assert.match(source, new RegExp(SYNTHETIC_DECODER_MARKER));
    assert.match(source, /__DROIDDOCK_STREAM_EVIDENCE__/);
    assert.match(source, /function canControl/);

    const status = await (await fetch(`${fixture.origin}/api/status`)).json();
    assert.equal(status.app, 'DroidDock');
    assert.equal(status.state, 'idle');
    assert.equal(status.fixture, true);
    assert.equal(status.evidence, SYNTHETIC_EVIDENCE);
    assert.equal(status.device, SYNTHETIC_DEVICE);

    const foreign = await new Promise((resolve, reject) => {
      const req = request(fixture.origin, { headers: { Host: 'evil.example' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(foreign, 403);
    assert.equal((await fetch(fixture.origin, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${fixture.origin}/package.json`)).status, 404);
  } finally {
    await fixture.close();
  }
});

test('fixture records controls, emits synthetic packets, errors, and takeover without ADB', { timeout: 10000 }, async () => {
  const fixture = await startSmokeFixture();
  const peers = [];
  function peer(path = '/stream?takeover=1', wsOrigin = fixture.origin) {
    const ws = new WebSocket(`ws://127.0.0.1:${fixture.port}${path}`, { origin: wsOrigin });
    const item = { ws, messages: [], packets: [], close: undefined };
    ws.on('message', (data, binary) => {
      if (binary) item.packets.push(Buffer.from(data));
      else item.messages.push(JSON.parse(data.toString()));
    });
    ws.on('close', (code, reason) => { item.close = { code, reason: reason.toString() }; });
    ws.on('error', () => {});
    peers.push(item);
    return item;
  }
  try {
    const rejected = peer('/stream?takeover=1', 'https://evil.example');
    const [error] = await once(rejected.ws, 'error', { signal: AbortSignal.timeout(3000) });
    assert.match(error.message, /403/);

    const first = peer();
    await once(first.ws, 'open', { signal: AbortSignal.timeout(3000) });
    await until(() => first.messages.find((message) => message.type === 'status' && message.snapshot === true), 'status snapshot');

    first.ws.send(JSON.stringify({ type: 'connect' }));
    await fixture.waitForInbound((message) => message.type === 'connect', 'connect command');
    await until(() => first.messages.find((message) => message.state === 'connecting'), 'connecting status');
    assert.equal(first.messages.find((message) => message.state === 'connecting').device, SYNTHETIC_DEVICE);

    first.ws.send(JSON.stringify({ type: 'touch', action: 0, x: 10, y: 20, width: 720, height: 1280 }));
    first.ws.send(JSON.stringify({ type: 'key', key: 'back' }));
    await fixture.waitForInbound((message) => message.type === 'key' && message.key === 'back', 'recorded Back');
    assert.deepEqual(fixture.inbound().filter((message) => message.type === 'touch'), [
      { type: 'touch', action: 0, x: 10, y: 20, width: 720, height: 1280 },
    ]);

    fixture.deliverSyntheticFrame();
    await until(() => first.packets.length >= 2, 'synthetic config and keyframe packets');

    fixture.emitError('Synthetic fixture error. Not a phone failure.');
    const failed = await until(() => first.messages.find((message) => message.state === 'error'), 'error status');
    assert.match(failed.message, /Synthetic fixture error/);

    const second = peer();
    await once(second.ws, 'open', { signal: AbortSignal.timeout(3000) });
    await until(() => first.close, 'displaced owner close');
    assert.equal(first.close.code, 4001);
    assert.deepEqual(first.messages.filter((message) => message.type === 'moved'), [{ type: 'moved', message: 'Phone opened elsewhere.' }]);
    assert.equal(fixture.owner()?.ws, second.ws);
  } finally {
    for (const item of peers) item.ws.terminate();
    await fixture.close();
  }
});
