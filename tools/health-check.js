'use strict';
// Probes every channel in the current build and reports which respond.
//
//   node tools/health-check.js
//
// IMPORTANT: this tests from THIS machine. Channels served only inside a
// particular country (BDIX ones, for example) will show as unreachable here
// but still work fine for someone on that network. Read the geo section as
// "unknown from here", not "dead".
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist', 'channels.js');
const OUT = path.join(__dirname, '..', 'config', 'health-report.txt');
const CONCURRENCY = 10;
const TIMEOUT_MS = 12000;

function loadSnapshot() {
  if (!fs.existsSync(DIST)) {
    throw new Error('dist/channels.js not found - run: npm run build');
  }
  const sandbox = { window: {} };
  // channels.js only assigns window.* literals, so evaluating it is enough.
  new Function('window', fs.readFileSync(DIST, 'utf8')).call(sandbox, sandbox.window);
  return sandbox.window.SNAPSHOT || [];
}

async function probe(ch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(ch.url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://example.com/' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const ms = Date.now() - started;
    if (!res.ok) return { ...ch, ok: false, status: res.status, ms };
    const body = (await res.text()).slice(0, 300);
    // A playlist that parses but lists nothing will not play either.
    const isPlaylist = body.includes('#EXTM3U');
    return { ...ch, ok: isPlaylist, status: res.status, ms, notPlaylist: !isPlaylist };
  } catch (err) {
    return {
      ...ch, ok: false, status: 0, ms: Date.now() - started,
      err: err.name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  } finally {
    clearTimeout(timer);
  }
}

(async function main() {
  const channels = loadSnapshot();
  console.log('Checking ' + channels.length + ' channels (this takes a minute)...\n');

  const queue = channels.slice();
  const results = [];
  let done = 0;

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const r = await probe(queue.shift());
      results.push(r);
      done++;
      if (done % 25 === 0) process.stdout.write('  ' + done + '/' + channels.length + '\n');
    }
  }));

  const working = results.filter((r) => r.ok);
  const refused = results.filter((r) => !r.ok && r.status >= 400);
  const unreachable = results.filter((r) => !r.ok && r.status === 0);
  const odd = results.filter((r) => !r.ok && r.status > 0 && r.status < 400);

  const lines = [];
  const section = (title, list, note) => {
    lines.push('');
    lines.push('== ' + title + ' (' + list.length + ') ' + '='.repeat(Math.max(0, 50 - title.length)));
    if (note) lines.push('   ' + note);
    lines.push('');
    for (const r of list.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))) {
      lines.push('  ' + r.name);
    }
  };

  lines.push('Channel health report - ' + new Date().toISOString().slice(0, 16).replace('T', ' '));
  lines.push('Checked from THIS machine. Geo-locked channels may still work elsewhere.');

  section('WORKING', working);
  section('REFUSED', refused,
    'Responded but said no (403 etc) - usually region- or referer-locked.');
  section('UNREACHABLE FROM HERE', unreachable,
    'No connection at all. BDIX/local channels look like this from abroad');
  if (odd.length) section('ODD RESPONSE', odd, 'Answered, but not with a playlist.');

  fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');

  // Machine-readable twin, so `npm run prune` can act on these results.
  fs.writeFileSync(
    OUT.replace(/\.txt$/, '.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        results: results.map((r) => ({ name: r.name, group: r.group, ok: !!r.ok })),
      },
      null,
      1
    ),
    'utf8'
  );

  const pct = (n) => ((n / results.length) * 100).toFixed(0) + '%';
  console.log('\n================= RESULT =================');
  console.log('  working from here : ' + working.length + '  (' + pct(working.length) + ')');
  console.log('  refused (403 etc) : ' + refused.length + '  (' + pct(refused.length) + ')');
  console.log('  unreachable       : ' + unreachable.length + '  (' + pct(unreachable.length) + ')');
  if (odd.length) console.log('  odd response      : ' + odd.length);
  console.log('==========================================');
  console.log('\nFull list: ' + path.relative(process.cwd(), OUT));

  // Group breakdown makes it obvious which whole categories are dead weight.
  const byGroup = new Map();
  for (const r of results) {
    if (!byGroup.has(r.group)) byGroup.set(r.group, { ok: 0, total: 0 });
    const g = byGroup.get(r.group);
    g.total++;
    if (r.ok) g.ok++;
  }
  console.log('\nBy group (working / total):');
  [...byGroup.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([g, s]) => {
      const bar = s.ok === 0 ? '  <- none work from here' : '';
      console.log('  ' + String(s.ok + '/' + s.total).padEnd(8) + g + bar);
    });
})().catch((err) => {
  console.error('Health check failed:', err.message);
  process.exitCode = 1;
});
