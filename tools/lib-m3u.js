'use strict';
// Shared M3U parsing for the build tools and the static site.
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

// The title is separated from the attributes by the first comma that is NOT
// inside a quoted value. Splitting on the first comma outright corrupts every
// entry whose logo URL contains one (CDN transforms like "f_png,w_300,q_85"
// are common), yielding garbage channel names and broken logos.
function splitExtinf(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) {
      return { attrs: line.slice(0, i), title: line.slice(i + 1).trim() };
    }
  }
  return { attrs: line, title: '' };
}


function parseM3U(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const { attrs: attrPart, title } = splitExtinf(line);

      const attrs = {};
      ATTR_RE.lastIndex = 0;
      let m;
      while ((m = ATTR_RE.exec(attrPart)) !== null) attrs[m[1].toLowerCase()] = m[2];

      pending = {
        name: title || attrs['tvg-name'] || 'Unnamed',
        logo: attrs['tvg-logo'] || null,
        group: attrs['group-title'] || 'Ungrouped',
      };
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pending) {
      out.push({ ...pending, url: line });
      pending = null;
    }
  }
  return out;
}

/**
 * Fetches several playlists and merges them into one channel list.
 *
 * On a name collision, the copy from whichever URL appears FIRST in `urls`
 * wins; later duplicates are dropped. This also means a source that goes
 * offline entirely is simply absent from the merge rather than breaking it -
 * one bad URL does not take down the others.
 */
async function fetchAndMerge(urls) {
  const seen = new Set();
  const merged = [];
  const failures = [];

  for (const url of urls) {
    let text;
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      text = await res.text();
    } catch (err) {
      failures.push({ url, error: err.message });
      continue;
    }

    const channels = parseM3U(text);
    let added = 0;
    for (const c of channels) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      merged.push({ ...c, source: url });
      added++;
    }
    failures.push({ url, ok: true, total: channels.length, added });
  }

  return { channels: merged, sources: failures };
}


/**
 * Why a URL cannot play in this site, or null if it can.
 *
 * Aggregated playlists carry plenty of entries that are not streams at all:
 * links to a YouTube or Twitch *page*, DASH manifests that hls.js cannot
 * decode, and literal placeholders. Including them just fills the channel list
 * with things that are guaranteed to fail.
 */
function unplayableReason(url) {
  const u = String(url || '').trim();
  if (u.startsWith('http://')) return 'http-only, cannot play on an https site';
  if (!/^https:\/\//i.test(u)) return 'not a stream URL';
  if (/(?:youtube\.com|youtu\.be|twitch\.tv|dailymotion\.com)/i.test(u)) {
    return 'links to a web page, not a stream';
  }
  if (/\.mpd(?:[?#]|$)/i.test(u)) return 'DASH stream, this player only handles HLS';
  return null;
}

module.exports = { parseM3U, fetchAndMerge, unplayableReason };
