'use strict';
const { config } = require('./config');
const { fetchWithTimeout } = require('./http');

const TIMEOUT_MS = 20000;

function apiUrl(action, params = {}) {
  const url = new URL('/player_api.php', config.xtream.base);
  url.searchParams.set('username', config.xtream.username);
  url.searchParams.set('password', config.xtream.password);
  if (action) url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  return url;
}

async function call(action, params) {
  const res = await fetchWithTimeout(
    apiUrl(action, params),
    { headers: { 'User-Agent': config.userAgent, Accept: 'application/json,*/*' } },
    TIMEOUT_MS
  );
  if (!res.ok) {
    throw new Error(`Xtream ${action || 'auth'} failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Panels under load often return an HTML error page with a 200.
    throw new Error(
      `Xtream ${action || 'auth'} returned non-JSON (${text.slice(0, 120)})`
    );
  }
}

// --- tiny TTL cache; channel lists are big and rarely change -------------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}
function clearCache() {
  cache.clear();
}

async function accountInfo() {
  const data = await call(null);
  if (!data || !data.user_info) throw new Error('Xtream login rejected - check username/password');
  const u = data.user_info;
  if (String(u.auth) === '0') throw new Error('Xtream login rejected - auth returned 0');
  return {
    username: u.username,
    status: u.status,
    expires: u.exp_date ? new Date(Number(u.exp_date) * 1000).toISOString() : null,
    maxConnections: Number(u.max_connections) || null,
    activeConnections: Number(u.active_cons) || 0,
    trial: String(u.is_trial) === '1',
    serverInfo: data.server_info || null,
  };
}

function normaliseChannel(raw) {
  return {
    id: String(raw.stream_id),
    name: raw.name || `Channel ${raw.stream_id}`,
    logo: raw.stream_icon || null,
    group: String(raw.category_id ?? ''),
    epgId: raw.epg_channel_id || null,
    number: Number(raw.num) || null,
    kind: 'live',
  };
}

async function liveCategories() {
  return cached('cats', 10 * 60 * 1000, async () => {
    const rows = await call('get_live_categories');
    if (!Array.isArray(rows)) return [];
    return rows.map((c) => ({
      id: String(c.category_id),
      name: c.category_name || 'Unnamed',
    }));
  });
}

async function liveChannels() {
  return cached('channels', 10 * 60 * 1000, async () => {
    const rows = await call('get_live_streams');
    if (!Array.isArray(rows)) return [];
    return rows.map(normaliseChannel);
  });
}

async function shortEpg(streamId, limit = 2) {
  return cached(`epg:${streamId}`, 60 * 1000, async () => {
    const data = await call('get_short_epg', { stream_id: streamId, limit });
    const list = (data && data.epg_listings) || [];
    return list.map((e) => ({
      // Xtream base64-encodes EPG text.
      title: safeB64(e.title),
      description: safeB64(e.description),
      start: e.start || null,
      end: e.end || null,
    }));
  });
}

function safeB64(s) {
  if (!s) return '';
  try {
    return Buffer.from(String(s), 'base64').toString('utf8');
  } catch {
    return String(s);
  }
}

// Upstream media URL for a live channel. Never leaves the server.
function liveStreamUrl(streamId, format) {
  const ext = format === 'ts' ? 'ts' : 'm3u8';
  const { base, username, password } = config.xtream;
  return `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(
    password
  )}/${encodeURIComponent(streamId)}.${ext}`;
}

module.exports = {
  accountInfo,
  liveCategories,
  liveChannels,
  shortEpg,
  liveStreamUrl,
  clearCache,
};
