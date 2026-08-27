'use strict';
// ---------------------------------------------------------------------------
// Fan-out: one upstream connection -> many viewers.
//
// A subscription that allows a single simultaneous stream cannot be handed to
// several friends directly. Instead the server itself is the one subscriber:
// it pulls a channel's HLS segments exactly once into memory, and every viewer
// is served from that cache. The provider only ever sees this server, pulling
// one segment at a time.
//
// The price is that everyone shares a channel. Two different channels would
// need two upstream connections, so the number of live channels is capped at
// whatever the provider actually allows (UPSTREAM_CONNECTIONS, normally 1).
// ---------------------------------------------------------------------------
const { config } = require('./config');
const { fetchWithTimeout } = require('./http');

const MIN_SEGMENTS_TO_SERVE = 2; // players stall if handed a one-segment window
const MAX_START_WAIT_MS = 25000;

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let targetDuration = 6;
  let mediaSequence = 0;
  let pendingDuration = null;
  let key = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]) || 6;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const m = line.match(/URI="([^"]+)"/);
      key = m ? { line, url: new URL(m[1], baseUrl).toString() } : null;
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice(8).split(',')[0]) || targetDuration;
    } else if (!line.startsWith('#')) {
      let abs;
      try {
        abs = new URL(line, baseUrl).toString();
      } catch {
        continue;
      }
      segments.push({
        url: abs,
        duration: pendingDuration == null ? targetDuration : pendingDuration,
        key,
      });
      pendingDuration = null;
    }
  }

  return { segments, targetDuration, mediaSequence };
}

class ChannelSession {
  constructor(channel, upstreamUrl) {
    this.channel = channel;
    this.upstreamUrl = upstreamUrl;
    this.running = false;
    this.startedAt = Date.now();
    this.lastViewerAt = Date.now();

    this.seq = 0;                 // our own monotonic segment counter
    this.byUrl = new Map();       // upstream url -> our seq (dedupe)
    this.segments = new Map();    // seq -> { buf, type, duration }
    this.window = [];             // ordered seqs currently advertised
    this.targetDuration = 6;
    this.keyCache = new Map();    // key url -> buf

    this.error = null;
    this.ready = false;
    this._readyWaiters = [];
    this._timer = null;
  }

  touch() {
    this.lastViewerAt = Date.now();
  }

  isIdle() {
    return Date.now() - this.lastViewerAt > config.idleStopMs;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._tick();
  }

  stop() {
    this.running = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this.segments.clear();
    this.byUrl.clear();
    this.window = [];
    this._resolveReady(new Error('Channel stopped'));
  }

  whenReady() {
    if (this.ready) return Promise.resolve();
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(this.error || new Error('Timed out waiting for the stream to start'));
      }, MAX_START_WAIT_MS);
      this._readyWaiters.push({ resolve, reject, timer });
    });
  }

  _resolveReady(err) {
    const waiters = this._readyWaiters;
    this._readyWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      if (err) w.reject(err);
      else w.resolve();
    }
  }

  async _tick() {
    if (!this.running) return;

    try {
      await this._refresh();
      this.error = null;
      if (!this.ready && this.window.length >= MIN_SEGMENTS_TO_SERVE) {
        this.ready = true;
        this._resolveReady(null);
      }
    } catch (err) {
      this.error = err;
      // A live playlist that fails once is common; only give up if we never
      // managed to serve anything at all.
      if (!this.ready) {
        this._resolveReady(err);
        this.running = false;
        return;
      }
    }

    if (!this.running) return;
    const waitMs = Math.min(Math.max((this.targetDuration * 1000) / 2, 2000), 10000);
    this._timer = setTimeout(() => this._tick(), waitMs);
  }

  async _refresh() {
    const res = await fetchWithTimeout(
      this.upstreamUrl,
      { headers: { 'User-Agent': config.userAgent }, redirect: 'follow' },
      20000
    );
    if (!res.ok) {
      throw new Error(
        res.status === 403 || res.status === 401
          ? 'Provider refused the stream (HTTP ' + res.status + '). The single ' +
            'connection may already be in use by another device.'
          : 'Provider returned HTTP ' + res.status
      );
    }

    const text = await res.text();
    if (!text.includes('#EXTM3U')) {
      throw new Error('Provider did not return an HLS playlist for this channel');
    }

    let { segments, targetDuration } = parsePlaylist(text, res.url || this.upstreamUrl);
    this.targetDuration = targetDuration;

    // A master playlist lists variants rather than segments; follow the first.
    if (segments.length && /\.m3u8(\?|$)/i.test(segments[0].url) && text.includes('#EXT-X-STREAM-INF')) {
      const variant = segments[0].url;
      const vres = await fetchWithTimeout(
        variant,
        { headers: { 'User-Agent': config.userAgent }, redirect: 'follow' },
        20000
      );
      if (!vres.ok) throw new Error('Variant playlist returned HTTP ' + vres.status);
      const vtext = await vres.text();
      const parsed = parsePlaylist(vtext, vres.url || variant);
      segments = parsed.segments;
      this.targetDuration = parsed.targetDuration;
      this.upstreamUrl = variant; // keep following the variant from now on
    }

    // Fetch only what we have not seen, one at a time so we never hold more
    // than a single upstream connection open.
    for (const seg of segments) {
      if (!this.running) return;
      if (this.byUrl.has(seg.url)) continue;
      await this._pullSegment(seg);
    }

    this._trim();
  }

  async _pullSegment(seg) {
    const res = await fetchWithTimeout(
      seg.url,
      { headers: { 'User-Agent': config.userAgent }, redirect: 'follow' },
      25000
    );
    if (!res.ok) throw new Error('Segment fetch failed: HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());

    if (seg.key && !this.keyCache.has(seg.key.url)) {
      const kres = await fetchWithTimeout(
        seg.key.url,
        { headers: { 'User-Agent': config.userAgent }, redirect: 'follow' },
        15000
      );
      if (kres.ok) this.keyCache.set(seg.key.url, Buffer.from(await kres.arrayBuffer()));
    }

    const seq = this.seq++;
    this.byUrl.set(seg.url, seq);
    this.segments.set(seq, {
      buf,
      type: res.headers.get('content-type') || 'video/mp2t',
      duration: seg.duration,
      key: seg.key || null,
    });
    this.window.push(seq);
  }

  _trim() {
    while (this.window.length > config.segmentWindow) {
      const gone = this.window.shift();
      const entry = this.segments.get(gone);
      this.segments.delete(gone);
      if (entry) {
        for (const [url, seq] of this.byUrl.entries()) {
          if (seq === gone) { this.byUrl.delete(url); break; }
        }
      }
    }
  }

  /** The playlist we hand to viewers - all URIs point back at this server. */
  playlist() {
    const out = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:' + Math.ceil(this.targetDuration),
      '#EXT-X-MEDIA-SEQUENCE:' + (this.window[0] == null ? 0 : this.window[0]),
    ];
    let lastKeyUrl = null;
    for (const seq of this.window) {
      const seg = this.segments.get(seq);
      if (!seg) continue;
      if (seg.key && seg.key.url !== lastKeyUrl) {
        out.push(seg.key.line.replace(/URI="[^"]+"/, 'URI="/api/live/key/' + seq + '"'));
        lastKeyUrl = seg.key.url;
      }
      out.push('#EXTINF:' + seg.duration.toFixed(3) + ',');
      out.push('/api/live/seg/' + seq);
    }
    return out.join('\n') + '\n';
  }

  segment(seq) {
    return this.segments.get(Number(seq)) || null;
  }

  keyFor(seq) {
    const seg = this.segments.get(Number(seq));
    if (!seg || !seg.key) return null;
    return this.keyCache.get(seg.key.url) || null;
  }

  stats() {
    return {
      channelId: this.channel.id,
      channelName: this.channel.name,
      since: this.startedAt,
      buffered: this.window.length,
      ready: this.ready,
      error: this.error ? this.error.message : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry - caps live channels at what the provider actually allows
// ---------------------------------------------------------------------------
const sessions = new Map(); // channelId -> ChannelSession

const janitor = setInterval(() => {
  for (const [id, s] of sessions.entries()) {
    if (s.isIdle()) {
      s.stop();
      sessions.delete(id);
    }
  }
}, 5000);
janitor.unref();

function get(channelId) {
  return sessions.get(String(channelId)) || null;
}

function active() {
  return [...sessions.values()].map((s) => s.stats());
}

/**
 * Join an existing channel, or open it if there is capacity.
 * Returns { ok, session } or { ok:false, code, message, active }.
 * `force` tears down another channel to make room.
 */
async function join(channel, upstreamUrl, force) {
  const id = String(channel.id);
  const existing = sessions.get(id);
  if (existing) {
    existing.touch();
    return { ok: true, session: existing, switched: false };
  }

  if (sessions.size >= config.upstreamConnections) {
    if (!force) {
      return {
        ok: false,
        code: 'CHANNEL_BUSY',
        message:
          'Your subscription allows ' + config.upstreamConnections +
          ' channel at a time and something else is already playing.',
        active: active(),
      };
    }
    // Oldest session yields; with a single connection there is only one.
    const victim = [...sessions.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    if (victim) {
      victim[1].stop();
      sessions.delete(victim[0]);
    }
  }

  const session = new ChannelSession(channel, upstreamUrl);
  sessions.set(id, session);
  session.start();

  try {
    await session.whenReady();
  } catch (err) {
    session.stop();
    sessions.delete(id);
    return { ok: false, code: 'START_FAILED', message: err.message, active: active() };
  }

  return { ok: true, session, switched: true };
}

function stopAll() {
  for (const s of sessions.values()) s.stop();
  sessions.clear();
}

module.exports = { join, get, active, stopAll, parsePlaylist, ChannelSession };
