'use strict';
// Writes config/channels.txt - the file you edit to choose what appears on
// the site. Every channel is listed under its group; comment out (or delete)
// the lines you do not want.
//
//   node tools/make-list.js
const fs = require('fs');
const path = require('path');
const { fetchAndMerge, unplayableReason } = require('./lib-m3u');
const { SOURCE_URLS } = require('./source-url');

const OUT = path.join(__dirname, '..', 'config', 'channels.txt');

/**
 * Reads an existing channels.txt back into "you enabled this" and "you turned
 * this off" sets.
 *
 * The distinction matters when a new playlist is added: a channel that is
 * simply NEW should arrive enabled, while one you deliberately commented out
 * must stay off. Treating both as "not enabled" would mean adding a source
 * silently imports nothing.
 */
function readExisting() {
  const enabled = new Set();
  const disabled = new Set();
  if (!fs.existsSync(OUT)) return { enabled, disabled, known: false };

  let inChannelArea = false;
  for (const line of fs.readFileSync(OUT, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('## ')) { inChannelArea = true; continue; } // group header
    if (!inChannelArea || !t) continue;

    if (t.startsWith('#')) {
      // Strip the comment marker and any trailing "   <- reason" annotation.
      const name = t.replace(/^#+\s*/, '').replace(/\s*<-.*$/, '').trim();
      if (name) disabled.add(name);
    } else {
      enabled.add(t);
    }
  }
  return { enabled, disabled, known: enabled.size + disabled.size > 0 };
}

async function main() {
  console.log('Fetching ' + SOURCE_URLS.length + ' playlist(s)...');
  const { channels, sources } = await fetchAndMerge(SOURCE_URLS);

  let collapsed = 0;
  for (const s of sources) {
    if (s.error) {
      console.log('  FAILED  ' + s.url + '  (' + s.error + ')');
    } else {
      const dupes = s.total - s.added;
      collapsed += dupes;
      console.log(
        '  ok      ' + s.total + ' channels, ' + s.added + ' new' +
        (dupes ? ', ' + dupes + ' dup' : '') + '   ' + s.url
      );
    }
  }
  console.log('');
  console.log(channels.length + ' unique channels after merging');

  if (!channels.length) {
    console.error('\nNo channels loaded from any source - check tools/source-url.js');
    process.exitCode = 1;
    return;
  }

  const prev = readExisting();
  if (prev.known) {
    console.log('Existing selection: ' + prev.enabled.size + ' on, ' +
      prev.disabled.size + ' off. New channels arrive enabled.');
  }

  const groups = new Map();
  for (const c of channels) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }

  const out = [
    '# ---------------------------------------------------------------',
    '#  Which channels appear on your site',
    '# ---------------------------------------------------------------',
    '#  One channel per line. Comment a line out with # to hide it,',
    '#  or delete the line entirely. Then run:  npm run build',
    '#',
    '#  To drop a whole category, comment out every line under its',
    '#  "## Group name" heading.',
    '#',
    '#  Lines already commented with "<- reason" cannot play in a',
    '#  browser at all (plain http, YouTube/Twitch page links, DASH).',
    '#',
    '#  Sourced from ' + SOURCE_URLS.length + ' playlist(s) - see tools/source-url.js.',
    '#  A name appearing in several playlists is kept once, from the',
    '#  source listed first there.',
    '#',
    '#  Regenerate any time with:  npm run channels',
    '#  Your on/off choices are preserved; brand-new channels arrive on.',
    '# ---------------------------------------------------------------',
    '',
  ];

  let enabledCount = 0;
  let blockedCount = 0;

  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [group, list] of sortedGroups) {
    out.push('## ' + group + '  (' + list.length + ')');
    for (const c of list) {
      const reason = unplayableReason(c.url);
      if (reason) {
        blockedCount++;
        out.push('# ' + c.name + '   <- ' + reason);
        continue;
      }
      let on;
      if (!prev.known) on = true;                      // first run: everything on
      else if (prev.enabled.has(c.name)) on = true;    // you had it on
      else if (prev.disabled.has(c.name)) on = false;  // you turned it off
      else on = true;                                  // brand new -> on

      if (on) { enabledCount++; out.push(c.name); }
      else out.push('# ' + c.name);
    }
    out.push('');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out.join('\n'), 'utf8');

  console.log('');
  console.log('Wrote ' + path.relative(process.cwd(), OUT));
  console.log('  ' + groups.size + ' groups, ' + channels.length + ' channels');
  console.log('  ' + enabledCount + ' enabled');
  console.log('  ' + blockedCount + ' commented out as unplayable in a browser');
  if (collapsed) console.log('  ' + collapsed + ' duplicate name(s) collapsed');
  console.log('');
  console.log('Edit that file, then run:  npm run build');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exitCode = 1;
});
