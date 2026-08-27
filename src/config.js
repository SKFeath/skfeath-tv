'use strict';
require('dotenv').config();

const crypto = require('crypto');

function parseAccessCodes(raw) {
  const users = new Map();
  for (const entry of (raw || '').split(',')) {
    const t = entry.trim();
    if (!t) continue;
    const idx = t.indexOf(':');
    // "name:code" gives a friendly label; a bare "code" labels itself.
    const name = idx === -1 ? t : t.slice(0, idx).trim();
    const code = idx === -1 ? t : t.slice(idx + 1).trim();
    if (code) users.set(code, name || 'guest');
  }
  return users;
}

function stripTrailingSlash(u) {
  return (u || '').trim().replace(/\/+$/, '');
}

const xtreamBase = stripTrailingSlash(process.env.XTREAM_BASE);
const m3uUrl = (process.env.M3U_URL || '').trim();

const config = {
  port: Number(process.env.PORT) || 3000,

  // 'xtream' unlocks categories/EPG/VOD; 'm3u' is the flat-playlist fallback.
  mode: xtreamBase ? 'xtream' : m3uUrl ? 'm3u' : 'unconfigured',

  xtream: {
    base: xtreamBase,
    username: (process.env.XTREAM_USERNAME || '').trim(),
    password: (process.env.XTREAM_PASSWORD || '').trim(),
  },

  m3uUrl,

  users: parseAccessCodes(process.env.ACCESS_CODES),

  sessionSecret:
    process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),

  // How many streams the PROVIDER allows at once. This is the number of
  // channels that can be live simultaneously - not the number of viewers.
  // One upstream connection is fanned out to unlimited viewers.
  upstreamConnections: Math.max(Number(process.env.UPSTREAM_CONNECTIONS) || 1, 1),

  // 'anyone' lets any viewer change the shared channel; 'owner' restricts it
  // to the codes named in CHANNEL_OWNERS.
  channelControl:
    (process.env.CHANNEL_CONTROL || 'anyone').toLowerCase() === 'owner' ? 'owner' : 'anyone',
  channelOwners: new Set(
    (process.env.CHANNEL_OWNERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  ),

  // Segments held in memory per channel. Larger = more rewind tolerance for
  // slow viewers, more RAM.
  segmentWindow: Math.max(Number(process.env.SEGMENT_WINDOW) || 8, 4),

  // Stop pulling from the provider this long after the last viewer request,
  // which releases the single upstream connection.
  idleStopMs: Math.max(Number(process.env.IDLE_STOP_SECONDS) || 40, 10) * 1000,

  // Some panels reject requests that do not look like a set-top box.
  userAgent: process.env.UPSTREAM_USER_AGENT || 'VLC/3.0.20 LibVLC/3.0.20',
};

function describeProblems() {
  const problems = [];
  if (config.mode === 'unconfigured') {
    problems.push('Set XTREAM_BASE (+ username/password) or M3U_URL in .env');
  }
  if (config.mode === 'xtream' && (!config.xtream.username || !config.xtream.password)) {
    problems.push('XTREAM_BASE is set but XTREAM_USERNAME / XTREAM_PASSWORD are missing');
  }
  if (config.users.size === 0) {
    problems.push('ACCESS_CODES is empty - nobody would be able to log in');
  }
  if (!process.env.SESSION_SECRET) {
    problems.push('SESSION_SECRET not set - sessions reset on every restart');
  }
  if (config.channelControl === 'owner' && config.channelOwners.size === 0) {
    problems.push('CHANNEL_CONTROL=owner but CHANNEL_OWNERS is empty - nobody could change channel');
  }
  return problems;
}

module.exports = { config, describeProblems };
