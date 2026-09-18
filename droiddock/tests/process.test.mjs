import test from 'node:test';
import assert from 'node:assert/strict';
import { runChecked, runCommand } from '../../dist/process.js';

test('command failures never expose executable paths, arguments or captured output', async () => {
  await assert.rejects(runChecked(process.execPath, ['-e', 'console.error("SYNTHETIC_PRIVATE_OUTPUT");process.exit(2)', 'SYNTHETIC_PRIVATE_ARGUMENT']), error => {
    assert.match(error.message, /device command failed/);
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE|node\.exe|process\.exit/);
    assert.equal(error.result.code, 2);
    return true;
  });
  await assert.rejects(runCommand('SYNTHETIC_PRIVATE_MISSING_EXECUTABLE', []), error => {
    assert.match(error.message, /could not start/);
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE/);
    return true;
  });
});

test('runner closes unused stdin and preserves normal command output', async () => {
  const result = await runChecked(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>console.log("done"))']);
  assert.equal(result.stdout.trim(), 'done');
});

test('runner bounds combined output and does not include overflow contents in errors', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stdout.write("SYNTHETIC_PRIVATE".repeat(10000));setInterval(()=>{},1000)'], { maxOutputBytes: 1000 }), error => {
    assert.match(error.message, /too much output/);
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE/);
    return true;
  });
});

test('deadline is a failure even if the process handles termination and exits successfully', async () => {
  const start = Date.now();
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1000)'], { timeoutMs: 200 }), /timed out/);
  assert.ok(Date.now() - start < 4000, 'deadline remains bounded');
});

test('deadline escalates a child that ignores termination', { skip: process.platform === 'win32' }, async () => {
  const start = Date.now();
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { timeoutMs: 200 }), /timed out/);
  assert.ok(Date.now() - start < 4000, 'ignored termination cannot prevent timeout');
});

test('inherited descendant pipes cannot turn a deadline into an indefinite wait', async () => {
  // The short-lived descendant needs no service, device, persistent process or
  // special cleanup. Its inherited pipes outlive the successful parent process.
  const script = 'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setTimeout(()=>{},1500)"],{stdio:"inherit",windowsHide:true});child.unref()';
  const start = Date.now();
  const result = await runCommand(process.execPath, ['-e', script], { timeoutMs: 200 }).catch(error => {
    assert.match(error.message, /timed out/);
    return undefined;
  });
  // Windows can close these inherited handles with the direct child; Unix
  // normally keeps them open. Either behavior must finish within our bound.
  if (result) assert.equal(result.code, 0);
  assert.ok(Date.now() - start < 1200, 'inherited handles do not determine the deadline');
});
