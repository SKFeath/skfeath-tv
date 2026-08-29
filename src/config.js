'use strict';
require('dotenv').config();

const crypto = require('crypto');

// ACCESS_CODES entries are "name:code:rank", where rank 1 is the Boss, 2 the
// next in line, and so on. Rank is optional and defaults to 999 (lowest).
// A bare "code" still works and gets the lowest rank.
//
// Whoever holds the remote at any moment is the LOWEST rank number currently
// in the room: Boss (1) present -> only Boss; Boss gone -> rank 2 takes over;
// and down the line. See src/auth.js.
function parseAccessCodes(raw) {
  const users = new Map();
  for (const entry of (raw || '').split(',')) {
    const t = entry.trim();
    if (!t) continue;
    const parts = t.split(':').map((s) => s.trim());
    let name, code, rank;
    if (parts.length >= 3) {
      [name, code] = parts;
      rank = Number(parts[2]);
    } else if (parts.length === 2) {
      [name, code] = parts;
    } else {
      name = code = parts[0];
    }
    if (!code) continue;
    users.set(code, { name: name || 'guest', rank: Number.isFinite(rank) ? rank : 999 });
  }
  return users;
}

function stripTrailingSlash(u) {
  return (u || '').trim().replace(/\/+$/, '');
}

const xtreamBase = stripTrailingSlash(process.env.XTREAM_BASE);
const m3uUrl = (process.env.M3U_URL || '').trim();

const users = parseAccessCodes(process.env.ACCESS_CODES);
const hasRanks = [...users.values()].some((u) => u.rank < 999);
const explicitControl = (process.env.CHANNEL_CONTROL || '').toLowerCase();

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

  users,

  sessionSecret:
    process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),

  // How many streams the PROVIDER allows at once. This is the number of
  // channels that can be live simultaneously - not the number of viewers.
  // One upstream connection is fanned out to unlimited viewers.
  upstreamConnections: Math.max(Number(process.env.UPSTREAM_CONNECTIONS) || 1, 1),

  // Channel control:
  //   'anyone' - any viewer can change the shared channel
  //   'roles'  - the highest-ranked person present holds the remote (see
  //              ACCESS_CODES ranks). "Boss, then 2nd, then 3rd" behaviour.
  // If CHANNEL_CONTROL is unset, roles turn on automatically as soon as any
  // access code carries a rank; otherwise it's 'anyone'.
  channelControl:
    explicitControl === 'anyone' ? 'anyone'
      : explicitControl === 'roles' ? 'roles'
      : hasRanks ? 'roles' : 'anyone',

  // After any channel change, block further changes for this long, so the
  // remote can't be spammed or fought over. 0 disables it (note: a plain
  // `|| 30` would wrongly treat 0 as unset, so parse explicitly).
  changeCooldownMs: (() => {
    const n = Number(process.env.CHANGE_COOLDOWN_SECONDS);
    return Math.max(Number.isFinite(n) ? n : 30, 0) * 1000;
  })(),

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
  if (config.channelControl === 'roles') {
    const ranked = [...config.users.values()].filter((u) => u.rank < 999);
    if (ranked.length === 0) {
      problems.push('CHANNEL_CONTROL is role-based but no access code has a rank - ' +
        'everyone is equal (anyone can change). Give at least a Boss a rank, e.g. ACCESS_CODES=boss:code:1');
    }
  }
  return problems;
}

module.exports = { config, describeProblems };
