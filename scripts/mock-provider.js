'use strict';
// A stand-in Xtream Codes panel, so the app can be exercised end to end
// without touching a real subscription. Not part of the running app.
//
// It behaves like a STRICT one-connection provider: a second simultaneous
// request to /live/ is refused with 403 and recorded as a violation, which is
// how the test suite proves the fan-out never exceeds a single connection.
const http = require('http');

const USER = 'testuser';
const PASS = 'testpass';
const MAX_UPSTREAM = Number(process.env.MOCK_MAX_UPSTREAM || 1);

const CATEGORIES = [
  { category_id: '1', category_name: 'UK Entertainment' },
  { category_id: '2', category_name: 'Sports' },
];

const STREAMS = [
  { num: 1, name: 'BBC One HD', stream_id: 101, stream_icon: '', epg_channel_id: 'bbc1', category_id: '1' },
  { num: 2, name: 'ITV HD', stream_id: 102, stream_icon: '', epg_channel_id: 'itv', category_id: '1' },
  { num: 3, name: 'Sky Sports Main', stream_id: 201, stream_icon: '', epg_channel_id: 'sky', category_id: '2' },
];

const SEGMENT = Buffer.alloc(4096, 0x47); // 0x47 = MPEG-TS sync byte
const SEGMENT_SECONDS = 2;
const startedAt = Date.now();

// Live playlists slide: the segment numbers advance with wall-clock time.
function currentMediaSequence() {
  return Math.floor((Date.now() - startedAt) / (SEGMENT_SECONDS * 1000));
}

const state = {
  liveInFlight: 0,
  peakLiveInFlight: 0,
  violations: 0,
  badAuth: 0,
  playlist: 0,
  segment: 0,
  raw: 0,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/player_api.php') {
    if (url.searchParams.get('username') !== USER || url.searchParams.get('password') !== PASS) {
      state.badAuth++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user_info: { auth: 0 } }));
    }
    const action = url.searchParams.get('action');
    res.writeHead(200, { 'Content-Type': 'application/json' });

    if (!action) {
      return res.end(JSON.stringify({
        user_info: {
          username: USER, auth: 1, status: 'Active',
          exp_date: String(Math.floor(Date.now() / 1000) + 86400 * 30),
          max_connections: String(MAX_UPSTREAM), active_cons: String(state.liveInFlight),
          is_trial: '0',
        },
        server_info: { url: 'localhost', port: '9911' },
      }));
    }
    if (action === 'get_live_categories') return res.end(JSON.stringify(CATEGORIES));
    if (action === 'get_live_streams') return res.end(JSON.stringify(STREAMS));
    if (action === 'get_short_epg') {
      return res.end(JSON.stringify({
        epg_listings: [
          { title: Buffer.from('The Six O’Clock News').toString('base64'),
            description: Buffer.from('Headlines').toString('base64'),
            start: '2026-08-28 18:00:00', end: '2026-08-28 18:30:00' },
          { title: Buffer.from('Regional News').toString('base64'),
            description: Buffer.from('Local').toString('base64'),
            start: '2026-08-28 18:30:00', end: '2026-08-28 19:00:00' },
        ],
      }));
    }
    return res.end('[]');
  }

  const live = url.pathname.match(/^\/live\/([^/]+)\/([^/]+)\/(.+)$/);
  if (live) {
    const [, u, p, file] = live;
    if (u !== USER || p !== PASS) {
      res.writeHead(401);
      return res.end('bad credentials');
    }

    // --- the single-connection enforcement -------------------------------
    state.liveInFlight++;
    state.peakLiveInFlight = Math.max(state.peakLiveInFlight, state.liveInFlight);
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      state.liveInFlight--;
    };
    res.on('close', release);
    res.on('finish', release);

    if (state.liveInFlight > MAX_UPSTREAM) {
      state.violations++;
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('too many connections');
    }

    if (file.endsWith('.m3u8')) {
      state.playlist++;
      const seq = currentMediaSequence();
      const body = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:' + SEGMENT_SECONDS,
        '#EXT-X-MEDIA-SEQUENCE:' + seq,
        '#EXTINF:' + SEGMENT_SECONDS + '.0,',
        'seg-' + seq + '.ts',
        '#EXTINF:' + SEGMENT_SECONDS + '.0,',
        'seg-' + (seq + 1) + '.ts',
        '#EXTINF:' + SEGMENT_SECONDS + '.0,',
        'seg-' + (seq + 2) + '.ts',
        '',
      ].join('\n');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(body);
    }

    if (file.endsWith('.ts')) {
      if (/^seg-/.test(file)) state.segment++;
      else state.raw++;
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': SEGMENT.length });
      return res.end(SEGMENT);
    }

    release();
    res.writeHead(404);
    return res.end('not found');
  }

  if (url.pathname === '/__hits') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state));
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(9911, '127.0.0.1', () =>
  console.log('mock provider on 9911 (max ' + MAX_UPSTREAM + ' upstream connection)')
);
