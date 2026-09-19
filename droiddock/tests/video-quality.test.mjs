import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as scriptQuality from '../../scripts/video-quality.mjs';
import * as compiledQuality from '../../dist/droiddock/video-quality.js';
import { scrcpyServerArgs, deviceServerCommand } from '../../dist/droiddock/session.js';
import { nextLocalConfig, resolveSetupSettings, setup, installationId, inspectPort } from '../../scripts/setup.mjs';
import { loadConfig, diagnose } from '../../scripts/Test-DroidDock.mjs';
import { phoneAction } from '../../scripts/phone.mjs';

const root = resolve('.');
const defaultVideo = { maxSize: 1280, maxFps: 60, videoBitRate: 6_000_000 };
const saverVideo = { maxSize: 800, maxFps: 30, videoBitRate: 2_000_000 };
const sample = { deviceSerial: 'SYNTHETICPHONE', adb: 'adb', deviceName: 'Android phone', port: 3210 };

function missingFile() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  return error;
}

test('script and compiled video-quality helpers stay identical', () => {
  assert.deepEqual(scriptQuality.VIDEO_QUALITY_PRESETS, compiledQuality.VIDEO_QUALITY_PRESETS);
  const values = [undefined, 'default', 'saver', '', 'Default', 'SAVER', ' balanced ', null, 1, true, { name: 'default' }, ['saver']];
  for (const value of values) {
    const run = helper => {
      try { return { ok: true, value: helper.resolveVideoQuality(value) }; }
      catch (error) { return { ok: false, message: error.message }; }
    };
    assert.deepEqual(run(scriptQuality), run(compiledQuality));
  }
  for (const video of [defaultVideo, saverVideo]) {
    const input = { ...sample, ...video };
    assert.equal(scriptQuality.configurationFingerprint(input), compiledQuality.configurationFingerprint(input));
    assert.deepEqual(scriptQuality.scrcpyVideoArgs(video), compiledQuality.scrcpyVideoArgs(video));
  }
});

test('omitted and default presets keep the current scrcpy arguments', () => {
  for (const helper of [scriptQuality, compiledQuality]) {
    assert.deepEqual(helper.resolveVideoQuality(undefined), { name: 'default', ...defaultVideo });
    assert.deepEqual(helper.resolveVideoQuality('default'), { name: 'default', ...defaultVideo });
    assert.deepEqual(helper.scrcpyVideoArgs(helper.resolveVideoQuality(undefined)), ['max_size=1280', 'max_fps=60', 'video_bit_rate=6000000']);
  }
  const args = scrcpyServerArgs('abcd1234', scriptQuality.resolveVideoQuality(undefined));
  assert.deepEqual(args, [
    'scid=abcd1234', 'tunnel_forward=true', 'audio=false', 'control=true', 'video_codec=h264',
    'max_size=1280', 'max_fps=60', 'video_bit_rate=6000000',
    'send_device_meta=false', 'clipboard_autosync=false', 'stay_awake=false', 'cleanup=true', 'log_level=warn',
  ]);
  const launched = deviceServerCommand('adb', 'TRANSPORT', '/data/local/tmp/droiddock-abcd1234.jar', 'abcd1234', scriptQuality.resolveVideoQuality('default'));
  assert.equal(launched.file, 'adb');
  assert.ok(launched.args.includes('max_size=1280'));
  assert.ok(launched.args.includes('max_fps=60'));
  assert.ok(launched.args.includes('video_bit_rate=6000000'));
  assert.equal(launched.args.includes('max_size=800'), false);
});

test('saver preset uses the agreed lower-bandwidth arguments', () => {
  const video = scriptQuality.resolveVideoQuality('saver');
  assert.deepEqual(video, { name: 'saver', ...saverVideo });
  assert.deepEqual(scriptQuality.scrcpyVideoArgs(video), ['max_size=800', 'max_fps=30', 'video_bit_rate=2000000']);
  const args = scrcpyServerArgs('abcd1234', video);
  assert.ok(args.includes('max_size=800'));
  assert.ok(args.includes('max_fps=30'));
  assert.ok(args.includes('video_bit_rate=2000000'));
  assert.equal(args.includes('max_size=1280'), false);
});

test('invalid types and names fail with sanitized guidance and do not echo values', () => {
  const cases = [
    [null, /must be a string/],
    [1, /must be a string/],
    [true, /must be a string/],
    [{}, /must be a string/],
    [[], /must be a string/],
    ['', /Unknown videoQuality/],
    ['Default', /Unknown videoQuality/],
    ['SYNTHETIC_BAD_PRESET', /Unknown videoQuality/],
  ];
  for (const [value, pattern] of cases) {
    for (const helper of [scriptQuality, compiledQuality]) {
      assert.throws(() => helper.resolveVideoQuality(value), error => {
        assert.match(error.message, pattern);
        assert.match(error.message, /Allowed values: default, saver/);
        assert.doesNotMatch(error.message, /SYNTHETIC_BAD_PRESET|config\.local|[/\\]|[A-Za-z]:\\/);
        return true;
      });
    }
  }
  assert.deepEqual(
    scriptQuality.resolveVideoQualityFromSources({ DROIDDOCK_VIDEO_QUALITY: 'saver' }, { videoQuality: 'default' }),
    { name: 'saver', ...saverVideo },
  );
  assert.throws(() => scriptQuality.resolveVideoQualityFromSources({}, { videoQuality: null }), /must be a string/);
  assert.throws(() => scriptQuality.resolveVideoQualityFromSources({ DROIDDOCK_VIDEO_QUALITY: '' }, { videoQuality: 'default' }), /Unknown videoQuality/);
});

test('fingerprints include effective integers and reject legacy or later-definition values', () => {
  const defaultId = scriptQuality.configurationFingerprint({ ...sample, ...defaultVideo });
  const saverId = scriptQuality.configurationFingerprint({ ...sample, ...saverVideo });
  const legacy = scriptQuality.legacyConfigurationFingerprint(sample);
  const changedDefinition = scriptQuality.configurationFingerprint({ ...sample, maxSize: 720, maxFps: 30, videoBitRate: 2_000_000 });
  assert.match(defaultId, /^[a-f0-9]{16}$/);
  assert.notEqual(defaultId, saverId);
  assert.notEqual(defaultId, legacy);
  assert.notEqual(saverId, changedDefinition);
  assert.equal(defaultId, compiledQuality.configurationFingerprintFromConfig({ ...sample, video: { name: 'default', ...defaultVideo } }));
  assert.equal(
    defaultId,
    createHash('sha256').update(JSON.stringify([sample.deviceSerial, sample.adb, sample.deviceName, sample.port, 1280, 60, 6000000])).digest('hex').slice(0, 16),
  );
});

test('setup, launch, phone, diagnostics, and server helpers hash the same resolved tuple', async () => {
  const video = scriptQuality.resolveVideoQuality('saver');
  const expected = scriptQuality.configurationFingerprint({ ...sample, ...video });
  assert.equal(scriptQuality.configurationFingerprintFromConfig({ ...sample, video }), expected);
  assert.equal(compiledQuality.configurationFingerprintFromConfig({ ...sample, video }), expected);
  const setupSettings = resolveSetupSettings({ ...sample, videoQuality: 'saver' }, {}, {});
  assert.deepEqual(setupSettings.video, video);
  assert.equal(scriptQuality.configurationFingerprint({
    deviceSerial: setupSettings.requested,
    adb: setupSettings.adb,
    deviceName: sample.deviceName,
    port: sample.port,
    maxSize: setupSettings.video.maxSize,
    maxFps: setupSettings.video.maxFps,
    videoBitRate: setupSettings.video.videoBitRate,
  }), expected);
  const folder = await mkdtemp(join(tmpdir(), 'droiddock-video-config-'));
  try {
    await writeFile(join(folder, 'config.local.json'), JSON.stringify({ ...sample, videoQuality: 'saver' }));
    const loaded = await loadConfig(folder, {});
    assert.equal(loaded.config.videoQuality, 'saver');
    assert.deepEqual(loaded.config.video, video);
    assert.equal(loaded.config.configurationId, expected);
    assert.equal(loaded.details.sources.videoQuality, 'config.local.json');
    assert.doesNotMatch(JSON.stringify(loaded.details), /SYNTHETICPHONE|saver/);
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('setup preserves a stored preset and does not write an environment-only override', () => {
  const preserved = nextLocalConfig({ videoQuality: 'saver', extra: 'keep' }, { adb: 'adb', deviceSerial: 'PHONE1', deviceName: 'Phone', port: 3211 });
  assert.equal(preserved.videoQuality, 'saver');
  assert.equal(preserved.extra, 'keep');
  assert.equal(preserved.port, 3211);
  const omitted = nextLocalConfig({ deviceSerial: 'PHONE1' }, { adb: 'adb', deviceSerial: 'PHONE1', deviceName: 'Phone', port: 3210 });
  assert.equal(Object.hasOwn(omitted, 'videoQuality'), false);
});

test('invalid presets fail in setup, diagnostics, launch, and service startup before device commands', async t => {
  const calls = [];
  const run = (...args) => { calls.push(args); return ''; };
  const privateName = 'SYNTHETIC_BAD_PRESET';
  await assert.rejects(setup({}, {
    env: { DROIDDOCK_VIDEO_QUALITY: privateName },
    readFile: async () => { throw missingFile(); },
    run,
  }), error => {
    assert.match(error.message, /Unknown videoQuality/);
    assert.doesNotMatch(error.message, new RegExp(privateName));
    return true;
  });
  await assert.rejects(setup({}, {
    env: {},
    readFile: async () => JSON.stringify({ videoQuality: null, deviceSerial: 'PHONE1' }),
    run,
  }), /must be a string/);
  assert.deepEqual(calls, []);

  const commandCalls = [];
  const report = await diagnose({
    root,
    env: { DROIDDOCK_DEVICE_SERIAL: 'SYNTHETICPHONE', DROIDDOCK_ADB: 'FAKEADB', DROIDDOCK_VIDEO_QUALITY: privateName },
    command: async (...args) => { commandCalls.push(args); return 'Android Debug Bridge version 1.0.41'; },
  });
  assert.equal(report.ok, false);
  assert.equal(commandCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(privateName));

  const launch = spawnSync(process.execPath, ['scripts/launch.mjs'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { ...process.env, DROIDDOCK_DEVICE_SERIAL: 'TESTONLY', DROIDDOCK_VIDEO_QUALITY: privateName, DROIDDOCK_PORT: '3210' },
  });
  assert.equal(launch.status, 1);
  assert.match(launch.stderr, /Unknown videoQuality/);
  assert.doesNotMatch(`${launch.stdout}${launch.stderr}`, new RegExp(privateName));

  const folder = await mkdtemp(join(tmpdir(), 'droiddock-invalid-config-'));
  t.after(() => rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const dest = join(folder, 'dist/droiddock');
  await mkdir(dest, { recursive: true });
  await copyFile(join(root, 'dist/droiddock/config.js'), join(dest, 'config.js'));
  await copyFile(join(root, 'dist/droiddock/video-quality.js'), join(dest, 'video-quality.js'));
  await writeFile(join(folder, 'config.local.json'), JSON.stringify({ deviceSerial: 'PHONE1', videoQuality: privateName }));
  const isolated = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(join(dest, 'config.js')).href)}).then(() => process.exit(0), error => { console.error(error.message); process.exit(1); })`], {
    cwd: folder, encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env },
  });
  assert.equal(isolated.status, 1);
  assert.match(isolated.stderr, /Unknown videoQuality/);
  assert.doesNotMatch(`${isolated.stdout}${isolated.stderr}`, new RegExp(privateName));
});

test('phone and launch refuse legacy, missing, and saver-mismatched fingerprints without mutations', async () => {
  const defaultId = scriptQuality.configurationFingerprint({ ...sample, ...defaultVideo });
  const saverId = scriptQuality.configurationFingerprint({ ...sample, ...saverVideo });
  const legacyId = scriptQuality.legacyConfigurationFingerprint(sample);
  for (const configurationId of [saverId, legacyId, undefined]) {
    const calls = [];
    await assert.rejects(phoneAction('open', {
      port: 3210,
      configurationId: defaultId,
      inspect: async () => ({ kind: 'ours', status: { configurationId, state: 'connected' } }),
      launch: async () => { calls.push('launch'); },
      request: async () => { calls.push('request'); return { ok: true }; },
    }), /different phone settings/);
    assert.deepEqual(calls, []);
  }
});

test('detached launcher reuses the same preset and refuses a different or legacy fingerprint', { timeout: 15000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, DROIDDOCK_PORT: String(port), DROIDDOCK_DEVICE_SERIAL: 'TESTONLY' };
  try {
    const started = spawnSync(process.execPath, ['scripts/launch.mjs'], { encoding: 'utf8', env, timeout: 10000, windowsHide: true });
    assert.equal(started.status, 0, started.stderr);
    const reuse = spawnSync(process.execPath, ['scripts/launch.mjs'], { encoding: 'utf8', env, timeout: 5000, windowsHide: true });
    assert.equal(reuse.status, 0, reuse.stderr);
    const saver = spawnSync(process.execPath, ['scripts/launch.mjs'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
      env: { ...env, DROIDDOCK_VIDEO_QUALITY: 'saver' },
    });
    assert.equal(saver.status, 1);
    assert.match(saver.stderr, /different configuration/);
    assert.equal((await inspectPort(port)).kind, 'ours');
  } finally {
    if ((await inspectPort(port)).kind === 'ours') await fetch(`${origin}/api/shutdown`, { method: 'POST', headers: { 'X-DroidDock': '1' } });
  }

  const legacy = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({
      app: 'DroidDock',
      installationId,
      state: 'idle',
      configurationId: scriptQuality.legacyConfigurationFingerprint({
        deviceSerial: 'TESTONLY',
        adb: process.env.DROIDDOCK_ADB ?? 'adb',
        deviceName: process.env.DROIDDOCK_DEVICE_NAME ?? 'Android phone',
        port,
      }),
    }));
  });
  legacy.listen(port, '127.0.0.1');
  await once(legacy, 'listening');
  try {
    const result = spawnSync(process.execPath, ['scripts/launch.mjs'], { encoding: 'utf8', env, timeout: 5000, windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /different configuration/);
    assert.equal((await inspectPort(port)).kind, 'ours');
  } finally {
    await new Promise(resolve => legacy.close(resolve));
  }
});
