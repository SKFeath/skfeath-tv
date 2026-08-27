'use strict';
// Connects to your actual provider and reports what works.
// Run with: npm run check
const { config, describeProblems } = require('../src/config');
const source = require('../src/source');
const { fetchWithTimeout } = require('../src/http');

const ok = (m) => console.log('  [ok]   ' + m);
const bad = (m) => console.log('  [FAIL] ' + m);
const info = (m) => console.log('         ' + m);

function redact(url) {
  if (config.mode !== 'xtream') return url;
  return String(url)
    .split(config.xtream.password).join('********')
    .split(config.xtream.username).join('<user>');
}

async function probe(url) {
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': config.userAgent }, redirect: 'follow' },
      15000
    );
    const ms = Date.now() - started;
    const type = res.headers.get('content-type') || 'unknown';
    let sample = '';
    if (res.ok) {
      const buf = Buffer.from(
        (await res.arrayBuffer().catch(() => new ArrayBuffer(0)))
      ).subarray(0, 256);
      sample = buf.toString('utf8');
    }
    return { status: res.status, ok: res.ok, type, ms, sample };
  } catch (err) {
    return { status: 0, ok: false, type: '', ms: Date.now() - started, error: err.message };
  }
}

(async function main() {
  console.log('\nIPTV source check');
  console.log('=================\n');

  const problems = describeProblems();
  if (problems.length) {
    console.log('Configuration warnings:');
    for (const p of problems) console.log('  ! ' + p);
    console.log('');
  }

  if (config.mode === 'unconfigured') {
    bad('No source configured. Copy .env.example to .env and fill it in.');
    process.exitCode = 1;
    return;
  }

  console.log('Mode: ' + config.mode);
  if (config.mode === 'xtream') info('Base: ' + config.xtream.base);
  console.log('');

  // --- account ---
  let account;
  try {
    account = await source.accountInfo();
    ok('Connected to provider');
    info('status      ' + (account.status || 'unknown'));
    if (account.expires) info('expires     ' + account.expires.slice(0, 10));
    if (account.maxConnections) {
      info('provider allows ' + account.maxConnections + ' simultaneous connection(s)');
      if (config.upstreamConnections > account.maxConnections) {
        console.log('');
        bad('UPSTREAM_CONNECTIONS (' + config.upstreamConnections + ') is HIGHER than your ' +
          'provider allows (' + account.maxConnections + ').');
        info('Set UPSTREAM_CONNECTIONS=' + account.maxConnections + ' in .env.');
      } else if (Number(account.maxConnections) === 1) {
        info('');
        info('One connection means everyone shares a single channel at a time.');
        info('Fan-out serves that one stream to unlimited viewers.');
      }
    }
  } catch (err) {
    bad('Could not reach the provider: ' + err.message);
    info('Check XTREAM_BASE / username / password, or M3U_URL.');
    process.exitCode = 1;
    return;
  }

  console.log('');

  // --- catalogue ---
  let channels = [];
  try {
    const cats = await source.liveCategories();
    channels = await source.liveChannels();
    ok(channels.length + ' channels across ' + cats.length + ' categories');
  } catch (err) {
    bad('Could not load the channel list: ' + err.message);
    process.exitCode = 1;
    return;
  }

  if (!channels.length) {
    bad('No channels returned - nothing to play.');
    process.exitCode = 1;
    return;
  }

  // --- stream formats ---
  console.log('');
  console.log('Testing playback formats on "' + channels[0].name + '":');

  const hlsUrl = await source.streamUrl(channels[0].id, 'hls');
  const tsUrl = await source.streamUrl(channels[0].id, 'ts');

  const hls = await probe(hlsUrl);
  const looksHls = hls.ok && (hls.sample.includes('#EXTM3U') || /mpegurl/i.test(hls.type));
  if (looksHls) ok('HLS  (.m3u8) works  [' + hls.ms + 'ms]');
  else bad('HLS  (.m3u8) failed  ' + (hls.error || 'HTTP ' + hls.status + ' ' + hls.type));

  let looksTs = false;
  if (config.mode === 'xtream' && tsUrl !== hlsUrl) {
    const ts = await probe(tsUrl);
    looksTs = ts.ok && !/html/i.test(ts.type);
    if (looksTs) ok('MPEG-TS (.ts) works  [' + ts.ms + 'ms]');
    else bad('MPEG-TS (.ts) failed  ' + (ts.error || 'HTTP ' + ts.status));
  }

  console.log('');
  if (looksHls) {
    ok('HLS available - fan-out will work, so any number of friends can watch.');
  } else if (looksTs) {
    bad('This provider serves MPEG-TS but not HLS for this channel.');
    info('Fan-out needs HLS to share one connection between viewers.');
    info('Try another channel, or ask your provider for an m3u8/HLS endpoint.');
  } else {
    bad('Neither format responded. The provider may be down, the credentials wrong,');
    info('or the single connection is already in use by another device.');
    info('Tried: ' + redact(hlsUrl));
  }

  console.log('');
})().catch((err) => {
  console.error('\nCheck crashed:', err.message);
  process.exitCode = 1;
});
