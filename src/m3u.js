'use strict';
const { config } = require('./config');
const { fetchWithTimeout } = require('./http');

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


// Parses #EXTINF playlists into the same channel shape the Xtream client emits.
// Upstream URLs are kept in a separate array so they never reach the browser.
function parseM3U(text) {
  const channels = [];
  const urls = [];
  const lines = String(text).split(/\r?\n/);
  let pending = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
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
        epgId: attrs['tvg-id'] || null,
      };
      continue;
    }

    if (line.startsWith('#')) continue; // #EXTVLCOPT, #EXTGRP etc.

    if (pending) {
      const id = String(urls.length);
      urls.push(line);
      channels.push({ id, ...pending, number: channels.length + 1, kind: 'live' });
      pending = null;
    }
  }

  return { channels, urls };
}

let state = { channels: [], urls: [], categories: [], loadedAt: 0 };

async function load(force = false) {
  const fresh = Date.now() - state.loadedAt < 10 * 60 * 1000;
  if (!force && state.channels.length && fresh) return state;

  const res = await fetchWithTimeout(
    config.m3uUrl,
    { headers: { 'User-Agent': config.userAgent }, redirect: 'follow' },
    60000
  );
  if (!res.ok) throw new Error(`M3U fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes('#EXTM3U') && !text.includes('#EXTINF')) {
    throw new Error('That URL did not return an M3U playlist');
  }

  const { channels, urls } = parseM3U(text);

  // group-title strings double as category ids in M3U mode.
  const names = [...new Set(channels.map((c) => c.group))].sort((a, b) =>
    a.localeCompare(b)
  );
  const categories = names.map((n) => ({ id: n, name: n }));

  state = { channels, urls, categories, loadedAt: Date.now() };
  return state;
}

async function liveCategories() {
  return (await load()).categories;
}
async function liveChannels() {
  return (await load()).channels;
}
async function liveStreamUrl(id) {
  const s = await load();
  return s.urls[Number(id)] || null;
}
async function accountInfo() {
  const s = await load();
  return {
    username: 'm3u playlist',
    status: 'Active',
    expires: null,
    maxConnections: null,
    activeConnections: 0,
    trial: false,
    channelCount: s.channels.length,
  };
}
function clearCache() {
  state = { channels: [], urls: [], categories: [], loadedAt: 0 };
}

module.exports = {
  parseM3U,
  accountInfo,
  liveCategories,
  liveChannels,
  liveStreamUrl,
  clearCache,
};
