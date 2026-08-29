'use strict';
// Self-contained test of ranked channel control + cooldown, against the mock
// provider. Spins up its own mock + server with ranked access codes, runs the
// checks, tears everything down. Run: node scripts/role-test.js
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = 'http://127.0.0.1:3112';
const PROVIDER_PORT = 9912;
const children = [];

function start(name, file, env) {
  const child = spawn(process.execPath, [file], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[' + name + '] ' + s); });
  children.push(child);
  return child;
}
function shutdown() { for (const c of children) { try { c.kill(); } catch (e) { /* gone */ } } }
async function waitForPort(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { await fetch('http://127.0.0.1:' + port + '/', { redirect: 'manual' }); return; }
    catch (e) { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error('nothing on port ' + port);
}

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const jars = {};
async function req(who, pathname, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (jars[who]) headers.Cookie = jars[who];
  const res = await fetch(APP + pathname, Object.assign({}, options, { headers, redirect: 'manual' }));
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) jars[who] = sc.map((c) => c.split(';')[0]).join('; ');
  return res;
}
const json = (r) => r.json().catch(() => ({}));
const login = (who, code) => req(who, '/api/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
});
const setChannel = (who, id, force) => req(who, '/api/room/channel', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: id, force: !!force }),
});
// heartbeat: /api/room marks the caller present
const beat = (who) => req(who, '/api/room');

(async function run() {
  process.on('exit', shutdown);

  // The mock provider listens on 9911. App uses a distinct port (3112) so this
  // never clashes with the main e2e run (3111/9911).
  start('provider', 'scripts/mock-provider.js', {});
  await waitForPort(9911);

  start('app', 'server.js', {
    XTREAM_BASE: 'http://127.0.0.1:9911',
    XTREAM_USERNAME: 'testuser', XTREAM_PASSWORD: 'testpass',
    // boss rank 1, alex rank 2, rafi rank 3, guest no rank (999)
    ACCESS_CODES: 'boss:boss-code:1,alex:alex-code:2,rafi:rafi-code:3,guest:guest-code',
    SESSION_SECRET: 'role-test-secret',
    CHANNEL_CONTROL: 'roles',
    UPSTREAM_CONNECTIONS: '1',
    IDLE_STOP_SECONDS: '30',
    CHANGE_COOLDOWN_SECONDS: '3',
    PORT: '3112',
  });
  await waitForPort(3112);

  console.log('\n--- login carries rank ---');
  let r = await login('boss', 'boss-code'); let b = await json(r);
  check('boss logs in with rank 1', b.rank === 1, JSON.stringify(b));
  await login('alex', 'alex-code');
  await login('rafi', 'rafi-code');
  await login('guest', 'guest-code');

  console.log('\n--- boss present: only boss holds the remote ---');
  // everyone heartbeats so all are "present"
  await Promise.all(['boss', 'alex', 'rafi', 'guest'].map(beat));
  r = await beat('alex'); b = await json(r);
  check('room reports boss as controller', b.controller && b.controller.user === 'boss', JSON.stringify(b.controller));
  check('alex (rank 2) cannot change while boss present', b.canChangeChannel === false);
  r = await beat('boss'); b = await json(r);
  check('boss can change', b.canChangeChannel === true);

  r = await setChannel('alex', '101'); b = await json(r);
  check('alex is refused (403) while boss present', r.status === 403, r.status + ' ' + JSON.stringify(b));
  r = await setChannel('boss', '101'); b = await json(r);
  check('boss successfully starts a channel', r.status === 200 && b.playing, r.status + ' ' + JSON.stringify(b));

  console.log('\n--- cooldown after a change ---');
  r = await setChannel('boss', '201'); b = await json(r);
  check('immediate second change is blocked by cooldown (429)', r.status === 429, r.status + ' ' + JSON.stringify(b));
  check('cooldown message mentions waiting', /wait/i.test(b.error || ''), b.error);

  console.log('\n--- control falls to rank 2 when boss leaves ---');
  await req('boss', '/api/leave', { method: 'POST' });
  // let boss presence expire is slow (30s TTL); /api/leave removes immediately
  await new Promise((r2) => setTimeout(r2, 3200)); // also clears the cooldown
  await Promise.all(['alex', 'rafi', 'guest'].map(beat));
  r = await beat('alex'); b = await json(r);
  check('with boss gone, alex (rank 2) is controller', b.controller && b.controller.user === 'alex', JSON.stringify(b.controller));
  check('alex can now change', b.canChangeChannel === true);
  r = await beat('rafi'); b = await json(r);
  check('rafi (rank 3) still cannot (alex present)', b.canChangeChannel === false);
  r = await setChannel('alex', '102', true); // confirm takeover (409 -> force)
  check('alex can now actually switch the channel', r.status === 200, 'got ' + r.status);

  console.log('\n--- control falls to rank 3 when boss AND alex leave ---');
  await req('alex', '/api/leave', { method: 'POST' });
  await new Promise((r2) => setTimeout(r2, 3200));
  await Promise.all(['rafi', 'guest'].map(beat));
  r = await beat('rafi'); b = await json(r);
  check('with boss+alex gone, rafi (rank 3) is controller', b.controller && b.controller.user === 'rafi', JSON.stringify(b.controller));
  r = await setChannel('rafi', '201', true); // confirm takeover
  check('rafi can switch', r.status === 200, 'got ' + r.status);
  await new Promise((r2) => setTimeout(r2, 3200)); // clear cooldown so we test the ROLE gate, not cooldown
  await beat('rafi'); // keep rafi present
  r = await setChannel('guest', '101'); b = await json(r);
  check('guest (rank 999) refused by ROLE while rafi present', r.status === 403 && b.code === 'NOT_CONTROLLER', r.status + ' ' + JSON.stringify(b));

  console.log('\n========================================');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('========================================\n');
  shutdown();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('role-test crashed:', e); shutdown(); process.exit(1); });
