'use strict';
const crypto = require('crypto');
const { config } = require('./config');

// Constant-time lookup so a wrong code cannot be found by timing.
function resolveCode(submitted) {
  const given = Buffer.from(String(submitted || ''), 'utf8');
  let matched = null;
  for (const [code, name] of config.users.entries()) {
    const known = Buffer.from(code, 'utf8');
    const ok = known.length === given.length && crypto.timingSafeEqual(known, given);
    if (ok) matched = name;
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

function canChangeChannel(session) {
  if (config.channelControl !== 'owner') return true;
  return config.channelOwners.has(session && session.code);
}

// ---------------------------------------------------------------------------
// Presence
//
// Viewers are NOT capped - fan-out means any number of them share the single
// upstream connection. This only tracks who is currently in the room so the UI
// can show it.
// ---------------------------------------------------------------------------
const PRESENCE_TTL_MS = 30000;
const watchers = new Map(); // sessionId -> { user, channelName, lastSeen, since }

let lastChange = null; // { user, channelName, at }

function sweep() {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [id, v] of watchers.entries()) {
    if (v.lastSeen < cutoff) watchers.delete(id);
  }
}

function seen(sessionId, user, channelName) {
  const existing = watchers.get(sessionId);
  watchers.set(sessionId, {
    user,
    channelName: channelName || (existing && existing.channelName) || null,
    lastSeen: Date.now(),
    since: existing ? existing.since : Date.now(),
  });
}

function leave(sessionId) {
  watchers.delete(sessionId);
}

function presence() {
  sweep();
  return [...watchers.values()].map((v) => ({
    user: v.user,
    channel: v.channelName,
    since: v.since,
  }));
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
  seen,
  leave,
  presence,
  noteChange,
  recentChange,
};
