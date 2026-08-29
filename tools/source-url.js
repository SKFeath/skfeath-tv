'use strict';
// Where the site's channels come from.
//
// Two kinds of source:
//  - REMOTE_SOURCES: big public playlists, fetched fresh over the network.
//    Each must send CORS headers (the browser fetches them directly). GitHub
//    raw does.
//  - config/extras.m3u: a small, hand-vetted local file for one-off finds.
//    The BUILD reads this from disk (not its GitHub URL) so a rebuild never
//    waits on GitHub's raw CDN cache, and you don't have to push before you
//    can build. The browser still gets its URL (below) for live refresh.
//
// On a name clash, the copy from whichever REMOTE source is listed first wins;
// extras are folded in last and only add names not already present.

const REMOTE_SOURCES = [
  // BDIX / Bangladesh - listed first so its links win on any name clash.
  'https://raw.githubusercontent.com/abusaeeidx/Mrgify-BDIX-IPTV/main/playlist.m3u',
  // Free-TV: large international list, grouped by country.
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
  // NOTE: iptv-org's sports.m3u was evaluated (Setanta Sports, GolTV) but
  // everything worth adding from it was plain http:// - blocked as mixed
  // content on this https site - so it isn't wired in.
];

// Hand-vetted one-off additions. Built from the local file; the browser
// refreshes from this URL.
const EXTRAS_FILE = 'config/extras.m3u';
const EXTRAS_URL =
  'https://raw.githubusercontent.com/SKFeath/skfeath-tv/main/config/extras.m3u';

// What the browser fetches for live refresh (baked into channels.js).
const SOURCE_URLS = [...REMOTE_SOURCES, EXTRAS_URL];

// The Homies live-TV room server (the fan-out server, e.g. on Oracle). The
// "Room" tab loads this in an iframe. Leave empty until the server is up -
// the tab then shows an "offline" screen. Set via ROOM_URL env at build time.
const ROOM_URL = (process.env.ROOM_URL || '').trim();

module.exports = { SOURCE_URLS, REMOTE_SOURCES, EXTRAS_FILE, ROOM_URL };
