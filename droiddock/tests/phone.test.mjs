import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneAction } from '../../scripts/phone.mjs';

function fixture(kind = 'ours', state = 'connected') {
  let service = { kind, status: { configurationId: 'expected', state, device: 'Test phone', message: 'Ready' } };
  const calls = [];
  return { calls, set: value => { service = value; }, options: {
    port: 3210, configurationId: 'expected', inspect: async () => service,
    launch: async () => { calls.push('launch'); service = { kind: 'ours', status: { configurationId: 'expected', state: 'idle' } }; },
    request: async (url, options) => { calls.push({ url, options }); service.status.state = 'idle'; return { ok: true }; },
  } };
}

test('status and disconnect on a stopped service never launch it', async () => {
  const f = fixture('free');
  for (const action of ['status', 'disconnect']) assert.equal((await phoneAction(action, f.options)).running, false);
  assert.deepEqual(f.calls, []);
});
test('open starts a stopped service once and preserves existing connected sessions', async () => {
  const f = fixture('free');
  assert.equal((await phoneAction('open', f.options)).state, 'idle');
  assert.deepEqual(f.calls, ['launch']);
  const active = fixture();
  assert.equal((await phoneAction('open', active.options)).state, 'connected');
  assert.deepEqual(active.calls, []);
});
test('all actions reject other installations and changed configuration without mutations', async () => {
  for (const action of ['open', 'status', 'disconnect']) {
    const f = fixture('occupied');
    await assert.rejects(phoneAction(action, f.options), /another service/);
    f.set({ kind: 'ours', status: { configurationId: 'other' } });
    await assert.rejects(phoneAction(action, f.options), /different phone settings/);
    assert.deepEqual(f.calls, []);
  }
});
test('disconnect uses only the guarded endpoint and verifies idle state', async () => {
  const f = fixture();
  assert.equal((await phoneAction('disconnect', f.options)).state, 'idle');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:3210/api/disconnect');
  assert.equal(f.calls[0].options.headers['X-DroidDock'], '1');
  assert.equal(f.calls[0].options.redirect, 'error');
  f.options.request = async () => ({ ok: false });
  await assert.rejects(phoneAction('disconnect', f.options), /did not confirm/);
  f.options.request = async () => ({ ok: true });
  f.set({ kind: 'ours', status: { configurationId: 'expected', state: 'connected' } });
  await assert.rejects(phoneAction('disconnect', f.options), /could not be verified/);
});
test('invalid actions and ports fail before any service access', async () => {
  const options = { port: 3210, inspect: () => assert.fail('must not access service') };
  await assert.rejects(phoneAction('shell', options), /Choose/);
  await assert.rejects(phoneAction('open', { ...options, port: 0 }), /Invalid/);
});
