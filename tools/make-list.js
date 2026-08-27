'use strict';
// Writes config/channels.txt - the file you edit to choose what appears on
// the site. Every channel is listed under its group; comment out (or delete)
// the lines you do not want.
//
//   node tools/make-list.js
const fs = require('fs');
const path = require('path');
const { parseM3U } = require('./lib-m3u');
const { SOURCE_URL } = require('./source-url');

const OUT = path.join(__dirname, '..', 'config', 'channels.txt');

async function main() {
  process.stdout.write('Fetching playlist... ');
  const res = await fetch(SOURCE_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  const channels = parseM3U(text);
  console.log(channels.length + ' channels');

  // Anything served over plain http:// cannot play on an https site - the
  // browser blocks it as mixed content. Pre-comment those so the list only
  // offers what can actually work.
  const insecure = channels.filter((c) => c.url.startsWith('http://')).length;

  const groups = new Map();
  for (const c of channels) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }

  const kept = new Set();
  if (fs.existsSync(OUT)) {
    // Preserve an existing selection so re-running does not undo your edits.
    for (const line of fs.readFileSync(OUT, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) kept.add(t);
    }
    console.log('Existing selection found: ' + kept.size + ' channels kept enabled.');
  }
  const isFirstRun = kept.size === 0;

  const out = [
    '# ---------------------------------------------------------------',
    '#  Which channels appear on your site',
    '# ---------------------------------------------------------------',
    '#  One channel per line. Comment a line out with # to hide it,',
    '#  or delete the line entirely. Then run:  npm run build',
    '#',
    '#  Channels marked "http-only" are commented out already: browsers',
    '#  refuse to load plain http:// video on an https:// page, so they',
    '#  cannot work on a hosted site.',
    '#',
    '#  Regenerate this file any time with:  npm run channels',
    '#  Your choices are preserved when you do.',
    '# ---------------------------------------------------------------',
    '',
  ];

  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [group, list] of sortedGroups) {
    out.push('## ' + group + '  (' + list.length + ')');
    for (const c of list) {
      const httpOnly = c.url.startsWith('http://');
      const enabled = isFirstRun ? !httpOnly : kept.has(c.name);
      if (httpOnly) out.push('# ' + c.name + '   <- http-only, cannot play on an https site');
      else if (enabled) out.push(c.name);
      else out.push('# ' + c.name);
    }
    out.push('');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out.join('\n'), 'utf8');

  console.log('');
  console.log('Wrote ' + path.relative(process.cwd(), OUT));
  console.log('  ' + groups.size + ' groups, ' + channels.length + ' channels');
  console.log('  ' + insecure + ' commented out as http-only');
  console.log('');
  console.log('Edit that file, then run:  npm run build');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exitCode = 1;
});
