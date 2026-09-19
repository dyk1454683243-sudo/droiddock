import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SYNTHETIC_DEVICE, SYNTHETIC_EVIDENCE, SYNTHETIC_FRAME_LABEL, startSmokeFixture } from './smoke-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifactDir = join(root, 'artifacts/smoke');
const WAIT_MS = 4000;

function fail(description, timeoutMs) {
  throw new Error(`Timed out waiting for ${description} (${timeoutMs}ms)`);
}

async function until(check, description, timeoutMs = WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  fail(description, timeoutMs);
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error('Playwright is a development dependency. Run npm ci --ignore-scripts and npx playwright install chromium.');
  }
}

async function openPage(context, origin) {
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'load', timeout: WAIT_MS });
  await page.locator('#connect').waitFor({ state: 'visible', timeout: WAIT_MS });
  await until(() => page.locator('#state').getAttribute('data-state'), 'initial connection state');
  return page;
}

async function connect(page, fixture) {
  await page.locator('#connect').click();
  await until(async () => (await page.locator('#state').getAttribute('data-state')) === 'connecting', 'Connecting state');
  if (fixture) await fixture.waitForInbound((message) => message.type === 'connect', 'connect command');
}

async function waitConnected(page) {
  await until(async () => {
    const state = await page.locator('#state').getAttribute('data-state');
    if (state === 'error') {
      throw new Error(`Synthetic connect failed: ${await page.locator('#empty-message').innerText()}`);
    }
    const hidden = await page.locator('#screen').evaluate((node) => node.hidden);
    return state === 'connected' && hidden === false;
  }, 'synthetic connected frame');
}

async function connectWithFrame(page, fixture) {
  await connect(page, fixture);
  fixture.deliverSyntheticFrame();
  await waitConnected(page);
}

async function phoneKeysDisabled(page) {
  return page.evaluate(() => [...document.querySelectorAll('[data-key]')].every((button) => button.disabled));
}

function expectedTouch(rect, clientX, clientY) {
  return {
    x: Math.max(0, Math.min(rect.canvasWidth - 1, Math.floor((clientX - rect.left) * rect.canvasWidth / rect.width))),
    y: Math.max(0, Math.min(rect.canvasHeight - 1, Math.floor((clientY - rect.top) * rect.canvasHeight / rect.height))),
    width: rect.canvasWidth,
    height: rect.canvasHeight,
  };
}

async function canvasRect(page) {
  return page.locator('#screen').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, canvasWidth: node.width, canvasHeight: node.height };
  });
}

async function pointerSequence(page, fixture, { clientX, clientY, moveX, moveY, cancel = false }) {
  const before = fixture.inbound().length;
  await page.evaluate(() => {
    window.__droiddockSmokePointers = [];
    if (window.__droiddockSmokePointerBound) return;
    window.__droiddockSmokePointerBound = true;
    const record = (event) => {
      window.__droiddockSmokePointers.push({
        type: event.type, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      });
    };
    const canvas = document.getElementById('screen');
    canvas.addEventListener('pointerdown', record);
    canvas.addEventListener('pointermove', record);
    canvas.addEventListener('pointerup', record);
    canvas.addEventListener('pointercancel', record);
  });
  await page.mouse.move(clientX, clientY);
  await page.mouse.down();
  await fixture.waitForInbound((message, index) => index >= before && message.type === 'touch' && message.action === 0, 'pointer down');
  if (cancel) {
    const pointerId = await page.evaluate(() => window.__droiddockSmokePointers.find((item) => item.type === 'pointerdown')?.pointerId);
    await page.evaluate((id) => {
      document.getElementById('screen').dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: id, bubbles: true, cancelable: true, pointerType: 'mouse',
      }));
    }, pointerId);
    await fixture.waitForInbound((message, index) => index >= before && message.type === 'touch' && message.action === 1, 'pointer cancel');
    await page.mouse.up();
    return page.evaluate(() => window.__droiddockSmokePointers);
  }
  if (moveX !== undefined) {
    await page.mouse.move(moveX, moveY);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await fixture.waitForInbound((message, index) => index >= before && message.type === 'touch' && message.action === 2, 'pointer move');
  }
  await page.mouse.up();
  await fixture.waitForInbound((message, index) => index >= before && message.type === 'touch' && message.action === 1, 'pointer up');
  return page.evaluate(() => window.__droiddockSmokePointers);
}

async function run() {
  const started = Date.now();
  const { chromium } = await loadPlaywright();
  const headed = process.env.DROIDDOCK_SMOKE_HEADED === '1';
  const fixture = await startSmokeFixture();
  const coverage = {
    evidence: SYNTHETIC_EVIDENCE,
    label: 'Generated/fake stream. Not Android video. Not H.264 compatibility evidence.',
    android: 'not-run',
    h264: 'not-claimed',
    phone: 'not-used',
    adb: 'not-used',
    nativeFullscreen: 'unavailable',
    nativeFullscreenReason: 'Not attempted yet.',
    headed,
    tests: [],
  };

  let browser;
  try {
    browser = await chromium.launch({
      headless: !headed,
      args: ['--disable-dev-shm-usage'],
    });
    coverage.browser = { name: 'chromium', version: browser.version() };
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    context.setDefaultTimeout(WAIT_MS);
    context.setDefaultNavigationTimeout(WAIT_MS);
    // Traces stay off. A failure screenshot is written only for the synthetic fixture.

    async function test(name, body) {
      const from = Date.now();
      try {
        await body();
        coverage.tests.push({ name, ok: true, durationMs: Date.now() - from });
        console.log(`ok - ${name}`);
      } catch (error) {
        coverage.tests.push({ name, ok: false, durationMs: Date.now() - from, error: error.message });
        throw error;
      }
    }

    await test('Connect, error, and disabled controls before a synthetic frame', async () => {
      const page = await openPage(context, fixture.origin);
      try {
        assert.equal(await page.locator('#state').getAttribute('data-state'), 'idle');
        assert.equal(await phoneKeysDisabled(page), true);
        assert.equal(await page.locator('#text-input').isDisabled(), true);
        assert.equal(await page.locator('#screen').evaluate((node) => node.hidden), true);

        await connect(page, fixture);
        assert.equal(await page.locator('#connect').getAttribute('aria-label'), 'Disconnect');
        assert.equal(await phoneKeysDisabled(page), true);

        fixture.emitError('Synthetic fixture error. Not a phone failure.');
        await until(async () => (await page.locator('#state').getAttribute('data-state')) === 'error', 'error state');
        assert.equal(await phoneKeysDisabled(page), true);
        assert.match(await page.locator('#empty-message').innerText(), /Synthetic fixture error/);
        assert.equal(await page.locator('#connect').getAttribute('aria-label'), 'Connect');
      } finally {
        await page.close();
        fixture.reset();
      }
    });

    await test('Handoff moves the first tab and leaves its controls disabled', async () => {
      const first = await openPage(context, fixture.origin);
      const second = await openPage(context, fixture.origin);
      try {
        await connectWithFrame(first, fixture);
        assert.equal(await phoneKeysDisabled(first), false);

        await connect(second, fixture);
        await until(async () => (await first.locator('#state').getAttribute('data-state')) === 'moved', 'first tab moved');
        assert.match(await first.locator('#empty-title').innerText(), /Phone opened elsewhere/);
        assert.equal(await phoneKeysDisabled(first), true);
        assert.equal(await first.locator('#connect').getAttribute('aria-label'), 'Connect');
        assert.equal(await second.locator('#state').getAttribute('data-state'), 'connecting');
        assert.equal(await phoneKeysDisabled(second), true);
      } finally {
        await second.close();
        await first.close();
        fixture.reset();
      }
    });

    await test('Keyboard focus, Tab order, and Details Escape do not send Android Back', async () => {
      const page = await openPage(context, fixture.origin);
      try {
        await connectWithFrame(page, fixture);
        assert.equal(await page.evaluate(() => window.__DROIDDOCK_STREAM_EVIDENCE__), SYNTHETIC_EVIDENCE);
        assert.match(await page.locator('#device').evaluate((node) => node.textContent), new RegExp(SYNTHETIC_DEVICE.replace(/[()]/g, '\\$&')));
        assert.equal(await page.locator('#resolution').evaluate((node) => node.textContent), '720 × 1280');
        assert.equal(await phoneKeysDisabled(page), false);

        await mkdir(artifactDir, { recursive: true });
        const shot = join(artifactDir, 'synthetic-fixture-not-android.png');
        await page.locator('#screen').screenshot({ path: shot });
        coverage.screenshot = {
          path: 'artifacts/smoke/synthetic-fixture-not-android.png',
          label: `${SYNTHETIC_FRAME_LABEL} — generated fixture, not Android or H.264`,
          bytes: (await stat(shot)).size,
        };

        await page.locator('#screen').focus();
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen');
        const tabOrder = [];
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press('Tab');
          tabOrder.push(await page.evaluate(() => {
            const el = document.activeElement;
            return el?.id || el?.getAttribute('data-key') || el?.getAttribute('aria-label') || el?.tagName;
          }));
        }
        assert.deepEqual(tabOrder.slice(0, 4), ['connect', 'back', 'home', 'recents']);
        assert.ok(tabOrder.includes('Help'));
        assert.ok(tabOrder.includes('Details and text input'));

        const beforeDetails = fixture.inbound().length;
        await page.locator('#more-controls > summary').click();
        assert.equal(await page.locator('#more-controls').evaluate((node) => node.open), true);
        await page.locator('#screen').focus();
        await page.keyboard.press('Escape');
        await until(async () => (await page.locator('#more-controls').evaluate((node) => node.open)) === false, 'Details closed');
        assert.equal(await page.evaluate(() => document.activeElement?.closest('#more-controls')?.querySelector('summary') === document.activeElement), true);
        assert.ok(!fixture.inbound().slice(beforeDetails).some((message) => message.type === 'key' && message.key === 'back'));

        const beforeHelp = fixture.inbound().length;
        await page.locator('#help-controls > summary').click();
        assert.equal(await page.locator('#help-controls').evaluate((node) => node.open), true);
        await page.locator('#screen').focus();
        await page.keyboard.press('Escape');
        await until(async () => (await page.locator('#help-controls').evaluate((node) => node.open)) === false, 'Help closed');
        assert.ok(!fixture.inbound().slice(beforeHelp).some((message) => message.type === 'key' && message.key === 'back'));
      } finally {
        await page.close();
        fixture.reset();
      }
    });

    await test('Pointer down, move, up, and cancel use real events and normalized coordinates', async () => {
      const page = await openPage(context, fixture.origin);
      try {
        await connectWithFrame(page, fixture);

        const firstRect = await canvasRect(page);
        assert.ok(firstRect.width > 0 && firstRect.height > 0);
        const downX = firstRect.left + firstRect.width * 0.25;
        const downY = firstRect.top + firstRect.height * 0.25;
        const moveX = firstRect.left + firstRect.width * 0.75;
        const moveY = firstRect.top + firstRect.height * 0.6;
        const firstEvents = await pointerSequence(page, fixture, { clientX: downX, clientY: downY, moveX, moveY });
        const first = fixture.inbound().filter((message) => message.type === 'touch').slice(-3);
        const downEvent = firstEvents.find((item) => item.type === 'pointerdown');
        const moveEvent = firstEvents.filter((item) => item.type === 'pointermove').at(-1);
        assert.equal(first[0].action, 0);
        assert.deepEqual({ x: first[0].x, y: first[0].y, width: first[0].width, height: first[0].height }, expectedTouch(firstRect, downEvent.clientX, downEvent.clientY));
        assert.equal(first[1].action, 2);
        assert.deepEqual({ x: first[1].x, y: first[1].y, width: first[1].width, height: first[1].height }, expectedTouch(firstRect, moveEvent.clientX, moveEvent.clientY));
        assert.equal(first[2].action, 1);

        await page.setViewportSize({ width: 1600, height: 900 });
        await until(async () => {
          const next = await canvasRect(page);
          return next.width !== firstRect.width || next.height !== firstRect.height;
        }, 'canvas resize after viewport change');
        const resized = await canvasRect(page);
        const tapX = resized.left + resized.width * 0.4;
        const tapY = resized.top + resized.height * 0.4;
        const resizedEvents = await pointerSequence(page, fixture, { clientX: tapX, clientY: tapY });
        const resizedTouch = fixture.inbound().filter((message) => message.type === 'touch' && message.action === 0).at(-1);
        const resizedDown = resizedEvents.find((item) => item.type === 'pointerdown');
        assert.deepEqual({ x: resizedTouch.x, y: resizedTouch.y, width: resizedTouch.width, height: resizedTouch.height }, expectedTouch(resized, resizedDown.clientX, resizedDown.clientY));

        const cancelX = resized.left + resized.width * 0.5;
        const cancelY = resized.top + resized.height * 0.5;
        const beforeCancel = fixture.inbound().length;
        await pointerSequence(page, fixture, { clientX: cancelX, clientY: cancelY, cancel: true });
        const cancelled = fixture.inbound().slice(beforeCancel).filter((message) => message.type === 'touch');
        assert.equal(cancelled[0].action, 0);
        assert.equal(cancelled.at(-1).action, 1);
        assert.ok(!cancelled.some((message) => message.action === 2));
      } finally {
        await page.close();
        fixture.reset();
      }
    });

    await test('Native fullscreen entry, coordinates, and Escape where the runner supports them', async () => {
      const page = await openPage(context, fixture.origin);
      try {
        await connectWithFrame(page, fixture);

        const api = await page.evaluate(() => ({
          enabled: Boolean(document.fullscreenEnabled),
          request: typeof document.getElementById('dock')?.requestFullscreen === 'function',
          hidden: document.getElementById('fullscreen')?.hidden === true,
        }));
        if (!api.enabled || !api.request || api.hidden) {
          coverage.nativeFullscreen = 'unavailable';
          coverage.nativeFullscreenReason = !api.enabled
            ? 'document.fullscreenEnabled is false on this runner.'
            : api.hidden
              ? 'Fullscreen control is hidden because the Fullscreen API is unavailable.'
              : 'Element.requestFullscreen is missing.';
          return;
        }

        await page.locator('#fullscreen').click({ timeout: 2000 });
        const entered = await page.waitForFunction(
          () => document.fullscreenElement?.id === 'dock' && document.getElementById('fullscreen')?.getAttribute('aria-pressed') === 'true',
          { timeout: 1500 },
        ).then(() => true).catch(() => false);
        if (!entered) {
          coverage.nativeFullscreen = 'unavailable';
          coverage.nativeFullscreenReason = 'dock.requestFullscreen did not make #dock the native fullscreen element. Fake fullscreenchange events were not used.';
          return;
        }
        coverage.nativeFullscreen = 'available';
        coverage.nativeFullscreenReason = 'Native Fullscreen API entered #dock.';

        await until(async () => (await canvasRect(page)).width > 0, 'fullscreen canvas layout');
        const fullRect = await canvasRect(page);
        const fullX = fullRect.left + fullRect.width * 0.3;
        const fullY = fullRect.top + fullRect.height * 0.3;
        const fullEvents = await pointerSequence(page, fixture, { clientX: fullX, clientY: fullY });
        const fullTouch = fixture.inbound().filter((message) => message.type === 'touch' && message.action === 0).at(-1);
        const fullDown = fullEvents.find((item) => item.type === 'pointerdown');
        assert.deepEqual({ x: fullTouch.x, y: fullTouch.y, width: fullTouch.width, height: fullTouch.height }, expectedTouch(fullRect, fullDown.clientX, fullDown.clientY));

        const beforeEscape = fixture.inbound().length;
        await page.locator('#screen').focus();
        await page.keyboard.press('Escape');
        const exited = await page.waitForFunction(
          () => document.fullscreenElement === null && document.getElementById('fullscreen')?.getAttribute('aria-pressed') === 'false',
          { timeout: 1000 },
        ).then(() => true).catch(() => false);
        if (!exited) {
          coverage.nativeFullscreen = 'available';
          coverage.nativeFullscreenReason = 'Native entry succeeded; Escape did not exit fullscreen on this runner.';
          await page.evaluate(() => { void document.exitFullscreen?.(); });
          await page.waitForFunction(
            () => document.fullscreenElement === null && document.getElementById('fullscreen')?.getAttribute('aria-pressed') === 'false',
            { timeout: 1500 },
          );
        }
        assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'), 'false');
        assert.ok(!fixture.inbound().slice(beforeEscape).some((message) => message.type === 'key' && message.key === 'back'));
      } finally {
        await page.close();
        fixture.reset();
      }
    });

    await context.close();
  } finally {
    await browser?.close();
    await fixture.close();
  }

  coverage.durationMs = Date.now() - started;
  coverage.ok = coverage.tests.every((item) => item.ok);
  await mkdir(artifactDir, { recursive: true });
  const summaryPath = join(artifactDir, 'smoke-coverage.json');
  await writeFile(summaryPath, `${JSON.stringify(coverage, null, 2)}\n`);
  coverage.summaryBytes = (await stat(summaryPath)).size;
  await writeFile(summaryPath, `${JSON.stringify(coverage, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: coverage.ok,
    evidence: coverage.evidence,
    nativeFullscreen: coverage.nativeFullscreen,
    nativeFullscreenReason: coverage.nativeFullscreenReason,
    durationMs: coverage.durationMs,
    screenshotBytes: coverage.screenshot?.bytes ?? 0,
    summaryBytes: coverage.summaryBytes,
    browser: coverage.browser,
  }));
  if (coverage.nativeFullscreen !== 'available') {
    console.log(`native fullscreen coverage: unavailable — ${coverage.nativeFullscreenReason}`);
  }
}

run().catch(async (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
