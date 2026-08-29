'use strict';
// Starts a fresh mock provider + app, runs the integration test, tears both
// down. Self-contained so repeat runs never inherit viewer slots or request
// counters from a previous run.
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP_PORT = 3111;
const PROVIDER_PORT = 9911;

const children = [];

function start(name, file, env) {
  const child = spawn(process.execPath, [file], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.log('[' + name + '] ' + s.split('\n').join('\n[' + name + '] '));
  });
  child.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.error('[' + name + '] ' + s);
  });
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) {
    try { c.kill(); } catch (e) { /* already gone */ }
  }
}

async function waitForPort(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch('http://127.0.0.1:' + port + '/', { redirect: 'manual' });
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error('Nothing came up on port ' + port);
}

(async function main() {
  process.on('exit', shutdown);
  process.on('SIGINT', () => { shutdown(); process.exit(130); });

  start('provider', 'scripts/mock-provider.js', {});
  await waitForPort(PROVIDER_PORT);

  start('app', 'server.js', {
    XTREAM_BASE: 'http://127.0.0.1:' + PROVIDER_PORT,
    XTREAM_USERNAME: 'testuser',
    XTREAM_PASSWORD: 'testpass',
    ACCESS_CODES:
      'alice:alice-code,bob:bob-code,carol:carol-code,' +
      'dave:dave-code,erin:erin-code,frank:frank-code',
    SESSION_SECRET: 'test-secret-for-integration',
    UPSTREAM_CONNECTIONS: '1',
    IDLE_STOP_SECONDS: '10',
    CHANGE_COOLDOWN_SECONDS: '0', // this suite tests fan-out, not the anti-flip cooldown
    PORT: String(APP_PORT),
  });
  await waitForPort(APP_PORT);

  const test = spawn(process.execPath, ['scripts/integration-test.js'], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  test.on('exit', (code) => {
    shutdown();
    process.exit(code === null ? 1 : code);
  });
})().catch((err) => {
  console.error('e2e runner failed:', err.message);
  shutdown();
  process.exit(1);
});
