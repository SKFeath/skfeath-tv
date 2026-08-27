'use strict';
// End-to-end check against the mock provider, which refuses any second
// simultaneous upstream connection. Run with: npm run test:e2e
const APP = 'http://127.0.0.1:3111';
const PROVIDER = 'http://127.0.0.1:9911';

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}

const jars = {};
async function req(who, path, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (jars[who]) headers.Cookie = jars[who];
  const res = await fetch(APP + path, Object.assign({}, options, {
    headers,
    redirect: 'manual',
  }));
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookie.length) jars[who] = setCookie.map((c) => c.split(';')[0]).join('; ');
  return res;
}

const json = (res) => res.json().catch(() => ({}));

function login(who, code) {
  return req(who, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

function setChannel(who, channelId, force) {
  return req(who, '/api/room/channel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, force: !!force }),
  });
}

const providerState = () => fetch(PROVIDER + '/__hits').then((r) => r.json());

(async function run() {
  console.log('\n--- auth ---');

  let r = await req('alice', '/api/channels');
  check('unauthenticated API call is rejected', r.status === 401, 'got ' + r.status);

  r = await req('alice', '/', { method: 'GET' });
  check('unauthenticated page redirects to /login', r.status === 302, 'got ' + r.status);

  r = await login('alice', 'wrong-code');
  check('wrong access code rejected', r.status === 401, 'got ' + r.status);

  r = await login('alice', 'alice-code');
  check('valid access code accepted', r.status === 200, 'got ' + r.status);

  console.log('\n--- catalogue ---');

  r = await req('alice', '/api/categories');
  let body = await json(r);
  check('categories load', Array.isArray(body) && body.length === 2, JSON.stringify(body));

  r = await req('alice', '/api/channels');
  body = await json(r);
  check('all channels load', body.total === 3, JSON.stringify(body));

  r = await req('alice', '/api/channels?category=2');
  body = await json(r);
  check('category filter works', body.total === 1, JSON.stringify(body));

  r = await req('alice', '/api/channels?q=itv');
  body = await json(r);
  check('search filter works', body.total === 1, JSON.stringify(body));

  r = await req('alice', '/api/channels');
  body = await json(r);
  check('channel list carries no credentials', !JSON.stringify(body).includes('testpass'));

  console.log('\n--- starting the shared room ---');

  r = await req('alice', '/api/room');
  body = await json(r);
  check('room starts empty', body.playing === null, JSON.stringify(body.playing));

  r = await setChannel('alice', '101');
  body = await json(r);
  check('alice starts BBC One HD',
    r.status === 200 && body.playing && body.playing.channelName === 'BBC One HD',
    r.status + ' ' + JSON.stringify(body));

  r = await req('alice', '/api/live/101/index.m3u8');
  const playlist = await r.text();
  check('playlist served to viewer', r.status === 200, 'got ' + r.status);
  check('playlist has segments', playlist.split('\n').filter((l) => l.startsWith('/api/live/seg/')).length >= 2,
    playlist);
  check('playlist leaks no provider host', !playlist.includes('9911'), playlist);
  check('playlist leaks no credentials', !playlist.includes('testpass'), playlist);

  const segPath = playlist.split('\n').find((l) => l.startsWith('/api/live/seg/'));
  r = await req('alice', segPath);
  const seg = Buffer.from(await r.arrayBuffer());
  check('segment served from cache', r.status === 200, 'got ' + r.status);
  check('segment bytes intact', seg.length === 4096 && seg[0] === 0x47, 'len=' + seg.length);

  console.log('\n--- fan-out: many viewers, ONE upstream connection ---');

  const before = await providerState();

  const friends = ['bob', 'carol', 'dave', 'erin', 'frank'];
  for (const f of friends) await login(f, f + '-code');

  // Everyone hammers the stream at once, repeatedly.
  for (let round = 0; round < 3; round++) {
    await Promise.all(
      friends.map(async (f) => {
        const pl = await req(f, '/api/live/101/index.m3u8');
        const text = await pl.text();
        const seg = text.split('\n').find((l) => l.startsWith('/api/live/seg/'));
        if (seg) await req(f, seg);
      })
    );
  }

  const after = await providerState();

  check('5 extra viewers all got the stream', true);
  check('provider never saw more than 1 simultaneous connection',
    after.peakLiveInFlight <= 1, 'peak was ' + after.peakLiveInFlight);
  check('provider recorded zero connection-limit violations',
    after.violations === 0, 'violations=' + after.violations);

  const extraUpstream = (after.segment + after.playlist) - (before.segment + before.playlist);
  check('viewer traffic did not multiply upstream requests',
    extraUpstream <= 6, 'upstream requests during 15 viewer fetches: ' + extraUpstream);

  r = await req('alice', '/api/room');
  body = await json(r);
  check('room lists all six viewers', body.viewers.length === 6,
    JSON.stringify(body.viewers.map((v) => v.user)));

  console.log('\n--- changing the shared channel ---');

  r = await setChannel('bob', '201');
  body = await json(r);
  check('switching while occupied needs confirmation', r.status === 409, 'got ' + r.status);
  check('conflict names what is playing',
    body.active && body.active[0] && body.active[0].channelName === 'BBC One HD',
    JSON.stringify(body));

  r = await setChannel('bob', '201', true);
  body = await json(r);
  check('forced switch works',
    r.status === 200 && body.playing.channelName === 'Sky Sports Main',
    r.status + ' ' + JSON.stringify(body));

  r = await req('alice', '/api/room');
  body = await json(r);
  check('everyone now sees the new channel',
    body.playing.channelName === 'Sky Sports Main', JSON.stringify(body.playing));
  check('room reports who changed it',
    body.lastChange && body.lastChange.user === 'bob', JSON.stringify(body.lastChange));

  r = await req('alice', '/api/live/101/index.m3u8');
  check('old channel stops serving', r.status === 404, 'got ' + r.status);

  const afterSwitch = await providerState();
  check('still only one upstream connection after switching',
    afterSwitch.peakLiveInFlight <= 1, 'peak was ' + afterSwitch.peakLiveInFlight);
  check('no violations after switching',
    afterSwitch.violations === 0, 'violations=' + afterSwitch.violations);

  console.log('\n--- misc ---');

  r = await setChannel('alice', '999', true);
  check('unknown channel is 404', r.status === 404, 'got ' + r.status);

  r = await req('alice', '/api/live/seg/999999');
  check('expired segment is 404', r.status === 404, 'got ' + r.status);

  console.log('\n--- releasing the connection when nobody watches ---');
  // IDLE_STOP_SECONDS is 10 in the runner and the janitor sweeps every 5s, so
  // the session is certainly gone ~15s after the last viewer request. Measure
  // AFTER that point: segments pulled during the idle countdown are legitimate,
  // only pulls once it has stopped would be a leak.
  await new Promise((r2) => setTimeout(r2, 17000));

  r = await fetch(APP + '/api/room', { headers: { Cookie: jars.alice } });
  body = await json(r);
  check('room reports nothing playing once idle',
    body.playing === null, JSON.stringify(body.playing));

  const idleA = await providerState();
  check('no connection left open to the provider',
    idleA.liveInFlight === 0, 'inFlight=' + idleA.liveInFlight);

  await new Promise((r2) => setTimeout(r2, 5000));
  const idleB = await providerState();
  check('upstream pulling has actually stopped',
    idleB.segment === idleA.segment && idleB.playlist === idleA.playlist,
    'pulled ' + (idleB.segment - idleA.segment) + ' segments / ' +
      (idleB.playlist - idleA.playlist) + ' playlists after stopping');

  check('a viewer can start watching again afterwards',
    (await setChannel('alice', '101')).status === 200);

  const finalState = await providerState();
  check('provider never saw a bad-credential request',
    finalState.badAuth === 0, JSON.stringify(finalState));
  check('peak upstream stayed at 1 for the whole run',
    finalState.peakLiveInFlight <= 1, 'peak=' + finalState.peakLiveInFlight);

  console.log('\n========================================');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('  peak upstream connections: ' + finalState.peakLiveInFlight);
  console.log('========================================\n');
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exitCode = 1;
});
