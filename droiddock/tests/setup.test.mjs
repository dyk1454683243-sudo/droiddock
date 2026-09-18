import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { chooseDevice, parseArgs, inspectPort } from '../../scripts/setup.mjs';

test('setup selects one physical phone, never a watch/emulator or ambiguous phones', () => {
  const phone = { serial: 'PHONE1', name: 'Phone', excluded: false };
  const watch = { serial: 'WATCH1', name: 'Watch', excluded: true };
  assert.equal(chooseDevice([watch]), null);
  assert.deepEqual(chooseDevice([watch, phone, { ...phone }]), phone);
  assert.equal(chooseDevice([phone, { ...phone, serial: 'PHONE2' }]), null);
  assert.equal(chooseDevice([phone], 'MISSING'), null);
  assert.equal(chooseDevice([watch, phone], 'PHONE1'), phone);
});

test('Windows installer refresh keeps tool precedence without multiplying PATH', { skip: process.platform !== 'win32' }, () => {
  const script = `
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts/Install-DroidDock.ps1'), [ref]$tokens, [ref]$errors)
    if ($errors.Count) { exit 1 }
    $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Refresh-DroidPath' }, $true)
    Invoke-Expression $function.Extent.Text
    $env:Path = 'C:\\DroidDockTest;C:\\droiddocktest\\;' + ((@($env:Path) * 3) -join ';')
    Refresh-DroidPath
    $first = $env:Path
    Refresh-DroidPath
    @{ stable=($first -eq $env:Path); first=($env:Path -split ';')[0]; copies=@(($env:Path -split ';') | Where-Object { $_.TrimEnd('\\') -ieq 'C:\\DroidDockTest' }).Count } | ConvertTo-Json -Compress
  `;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0);
  const actual = JSON.parse(result.stdout);
  assert.equal(actual.stable, true);
  assert.equal(actual.first, 'C:\\DroidDockTest');
  assert.equal(actual.copies, 1);
});

test('detached launcher returns promptly and leaves a healthy service that can shut down', { timeout: 15000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const result = spawnSync(process.execPath, ['scripts/launch.mjs'], { encoding:'utf8', env:{...process.env, DROIDDOCK_PORT:String(port), DROIDDOCK_DEVICE_SERIAL:'TESTONLY'}, timeout:10000, windowsHide:true });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `${origin}/`);
    assert.equal((await inspectPort(port)).kind, 'ours');
    const again = spawnSync(process.execPath, ['scripts/launch.mjs'], { encoding:'utf8', env:{...process.env, DROIDDOCK_PORT:String(port), DROIDDOCK_DEVICE_SERIAL:'DIFFERENT'}, timeout:5000, windowsHide:true });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /different configuration/);
  } finally {
    if ((await inspectPort(port)).kind === 'ours') await fetch(`${origin}/api/shutdown`, { method:'POST', headers:{'X-DroidDock':'1'} });
  }
});

test('setup rejects malformed and incomplete explicit configuration', () => {
  for (const args of [['--port','0'], ['--port','65536'], ['--port','3210.5'], ['--port'], ['--device-serial','bad;command'], ['--unknown']]) assert.throws(() => parseArgs(args));
  assert.deepEqual(parseArgs(['--port','3211','--adb','C:\\Program Files\\adb.exe','--no-launch']), {port:'3211', adb:'C:\\Program Files\\adb.exe', noLaunch:true});
});

test('setup CLI does not disclose a failed executable path or unknown argument', () => {
  const privateMarker = 'SYNTHETIC_PRIVATE_VALUE';
  for (const args of [['--adb', `${privateMarker}/nonexistent-adb`], [`--${privateMarker}`]]) {
    const result = spawnSync(process.execPath, ['scripts/setup.mjs', ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout.trim()).status, 'error');
    assert.ok(!`${result.stdout}${result.stderr}`.includes(privateMarker));
  }
});

test('setup never reuses another checkout or an unrelated service', async () => {
  let identity = 'other';
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ app:'DroidDock', installationId:identity, state:'idle' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  try {
    assert.equal((await inspectPort(port, 'ours')).kind, 'occupied');
    identity = 'ours';
    assert.equal((await inspectPort(port, 'ours')).kind, 'ours');
  } finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal((await inspectPort(port, 'ours')).kind, 'free');
});
