'use strict';
const crypto = require('crypto');
const { config } = require('./config');

// Constant-time lookup so a wrong code cannot be found by timing.
// Returns { name, rank } for a valid code, or null.
function resolveCode(submitted) {
  const given = Buffer.from(String(submitted || ''), 'utf8');
  let matched = null;
  for (const [code, info] of config.users.entries()) {
    const known = Buffer.from(code, 'utf8');
    const ok = known.length === given.length && crypto.timingSafeEqual(known, given);
    if (ok) matched = info;
  }
  return matched;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  // originalUrl, not path: inside a router mounted at /api, req.path has
  // already had the mount point stripped, so an API call would otherwise be
  // answered with an HTML redirect that fetch() cannot parse.
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not signed in' });
  }
  return res.redirect('/login');
}

// ---------------------------------------------------------------------------
// Presence
//
// Viewers are NOT capped - fan-out means any number of them share the single
// upstream connection. Presence tracks who is in the room (and their rank) so
// the UI can show it and so control can pass down the ranking.
// ---------------------------------------------------------------------------
const PRESENCE_TTL_MS = 30000;
const watchers = new Map(); // sessionId -> { user, rank, channelName, lastSeen, since }

let lastChange = null; // { user, channelName, at }

function sweep() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [id, v] of watchers.entries()) {
    if (v.lastSeen < cutoff) watchers.delete(id);
  }
}

function seen(sessionId, session, channelName) {
  const existing = watchers.get(sessionId);
  watchers.set(sessionId, {
    user: (session && session.user) || 'guest',
    rank: session && Number.isFinite(session.rank) ? session.rank : 999,
    channelName: channelName || (existing && existing.channelName) || null,
    lastSeen: Date.now(),
    since: existing ? existing.since : Date.now(),
  });
}

function leave(sessionId) {
  watchers.delete(sessionId);
}

// The rank that currently holds the remote: the lowest rank number present.
// Boss (1) present -> 1; Boss gone but rank 2 present -> 2; and so on.
// null when the room is empty.
function controllerRank() {
  sweep();
  let min = null;
  for (const v of watchers.values()) {
    if (min === null || v.rank < min) min = v.rank;
  }
  return min;
}

function presence() {
  sweep();
  const holdRank = controllerRank();
  return [...watchers.values()]
    .map((v) => ({
      user: v.user,
      rank: v.rank,
      channel: v.channelName,
      since: v.since,
      controlling: v.rank === holdRank, // holds the remote right now
    }))
    .sort((a, b) => a.rank - b.rank || a.since - b.since);
}

// ---------------------------------------------------------------------------
// Who may change the channel, and the anti-flip cooldown
// ---------------------------------------------------------------------------
function cooldownRemainingMs() {
  if (!config.changeCooldownMs || !lastChange) return 0;
  const left = lastChange.at + config.changeCooldownMs - Date.now();
  return left > 0 ? left : 0;
}

/**
 * @returns {{ok: true} | {ok:false, reason, code, retryMs?}}
 */
function mayChangeChannel(session) {
  const cd = cooldownRemainingMs();
  if (cd > 0) {
    return {
      ok: false,
      code: 'COOLDOWN',
      retryMs: cd,
      reason: 'Channel was just changed - wait ' + Math.ceil(cd / 1000) + 's before changing again.',
    };
  }

  if (config.channelControl === 'anyone') return { ok: true };

  // roles mode: only the highest-ranked person currently in the room.
  const myRank = session && Number.isFinite(session.rank) ? session.rank : 999;
  const holdRank = controllerRank();
  if (holdRank === null || myRank === holdRank) return { ok: true };

  // Someone higher-ranked is in the room and holds the remote.
  const holder = [...watchers.values()].find((v) => v.rank === holdRank);
  return {
    ok: false,
    code: 'NOT_CONTROLLER',
    reason: (holder ? holder.user : 'Someone higher-ranked') +
      ' has the remote right now. You can change it when they leave.',
  };
}

// kept for any callers that just want a yes/no
function canChangeChannel(session) {
  return mayChangeChannel(session).ok;
}

function noteChange(user, channelName) {
  lastChange = { user, channelName, at: Date.now() };
}

function recentChange() {
  if (!lastChange) return null;
  return Date.now() - lastChange.at < 15000 ? lastChange : null;
}

module.exports = {
  resolveCode,
  requireAuth,
  canChangeChannel,
  mayChangeChannel,
  cooldownRemainingMs,
  controllerRank,
  seen,
  leave,
  presence,
  noteChange,
  recentChange,
};
