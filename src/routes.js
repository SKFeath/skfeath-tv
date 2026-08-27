'use strict';
const express = require('express');
const { config } = require('./config');
const source = require('./source');
const auth = require('./auth');
const fanout = require('./fanout');

const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- session ---------------------------------------------------------------
router.post('/login', (req, res) => {
  const name = auth.resolveCode(req.body && req.body.code);
  if (!name) return res.status(401).json({ error: 'That access code is not valid.' });
  const code = String((req.body && req.body.code) || '');
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Could not start a session.' });
    req.session.user = name;
    req.session.code = code;
    res.json({ ok: true, user: name });
  });
});

router.post('/logout', (req, res) => {
  auth.leave(req.sessionID);
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({
    user: req.session.user,
    mode: source.mode,
    canChangeChannel: auth.canChangeChannel(req.session),
    upstreamConnections: config.upstreamConnections,
  });
});

router.use(auth.requireAuth);

// --- catalogue -------------------------------------------------------------
router.get('/account', wrap(async (req, res) => {
  const info = await source.accountInfo();
  res.json({ ...info, limits: { upstreamConnections: config.upstreamConnections } });
}));

router.get('/categories', wrap(async (req, res) => {
  res.json(await source.liveCategories());
}));

router.get('/channels', wrap(async (req, res) => {
  const all = await source.liveChannels();
  const category = (req.query.category || '').trim();
  const q = (req.query.q || '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 300, 1000);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  let rows = all;
  if (category && category !== 'all') rows = rows.filter((c) => c.group === category);
  if (q) rows = rows.filter((c) => c.name.toLowerCase().includes(q));

  res.json({ total: rows.length, offset, limit, items: rows.slice(offset, offset + limit) });
}));

router.get('/epg/:id', wrap(async (req, res) => {
  res.json(await source.shortEpg(req.params.id));
}));

// --- the shared room -------------------------------------------------------
// Everyone watches the same channel, because the subscription only permits
// UPSTREAM_CONNECTIONS live channels at a time.
router.get('/room', (req, res) => {
  auth.seen(req.sessionID, req.session.user);
  const live = fanout.active();
  res.json({
    playing: live[0] || null,
    live,
    viewers: auth.presence(),
    lastChange: auth.recentChange(),
    canChangeChannel: auth.canChangeChannel(req.session),
    upstreamConnections: config.upstreamConnections,
  });
});

/**
 * Ask for a channel. Joining whatever is already on is always allowed and
 * costs nothing; starting a different one takes the single upstream
 * connection, so it needs ?force=1 once the client has confirmed.
 */
router.post('/room/channel', wrap(async (req, res) => {
  if (!auth.canChangeChannel(req.session)) {
    return res.status(403).json({ error: 'Only the owner can change the channel here.' });
  }

  const id = String((req.body && req.body.channelId) || '');
  const force = Boolean(req.body && req.body.force);

  const channels = await source.liveChannels();
  const channel = channels.find((c) => c.id === id);
  if (!channel) return res.status(404).json({ error: 'No such channel' });

  const upstreamUrl = await source.streamUrl(channel.id, 'hls');
  if (!upstreamUrl) return res.status(404).json({ error: 'No stream URL for that channel' });

  const result = await fanout.join(channel, upstreamUrl, force);
  if (!result.ok) {
    const status = result.code === 'CHANNEL_BUSY' ? 409 : 502;
    return res.status(status).json({
      error: result.message,
      code: result.code,
      active: result.active,
    });
  }

  auth.seen(req.sessionID, req.session.user, channel.name);
  if (result.switched) auth.noteChange(req.session.user, channel.name);

  res.json({ ok: true, playing: result.session.stats(), switched: result.switched });
}));

// --- playback --------------------------------------------------------------
// These serve purely from the in-memory cache; no viewer request ever reaches
// the provider.
router.get('/live/:id/index.m3u8', (req, res) => {
  const session = fanout.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'That channel is not playing right now.' });
  session.touch();
  auth.seen(req.sessionID, req.session.user, session.channel.name);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.send(session.playlist());
});

router.get('/live/seg/:seq', (req, res) => {
  const live = fanout.active();
  if (!live.length) return res.status(404).end();
  const session = fanout.get(live[0].channelId);
  if (!session) return res.status(404).end();

  session.touch();
  const seg = session.segment(req.params.seq);
  if (!seg) return res.status(404).json({ error: 'Segment expired' });

  res.setHeader('Content-Type', seg.type);
  res.setHeader('Cache-Control', 'public, max-age=30');
  res.send(seg.buf);
});

router.get('/live/key/:seq', (req, res) => {
  const live = fanout.active();
  if (!live.length) return res.status(404).end();
  const session = fanout.get(live[0].channelId);
  if (!session) return res.status(404).end();
  const key = session.keyFor(req.params.seq);
  if (!key) return res.status(404).end();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(key);
});

router.post('/leave', (req, res) => {
  auth.leave(req.sessionID);
  res.json({ ok: true });
});

module.exports = router;
