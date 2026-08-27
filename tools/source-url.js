'use strict';
// The playlist the site is built from. Change this one line to point the whole
// site at a different M3U.
//
// This URL must send CORS headers (Access-Control-Allow-Origin), because the
// site refreshes itself from the browser. GitHub raw does.
const SOURCE_URL =
  'https://raw.githubusercontent.com/abusaeeidx/Mrgify-BDIX-IPTV/main/playlist.m3u';

module.exports = { SOURCE_URL };
