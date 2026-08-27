'use strict';
// The playlists the site is built from. Add or remove URLs to change what
// feeds the whole site.
//
// Each URL must send CORS headers (Access-Control-Allow-Origin), because the
// browser fetches it directly. GitHub raw does.
//
// When the same channel name appears in more than one playlist, the copy from
// whichever URL is listed FIRST wins and the rest are dropped - so order
// matters if you care which source's link is used for a given channel.
const SOURCE_URLS = [
  // BDIX / Bangladesh - listed first so its links win on any name clash.
  'https://raw.githubusercontent.com/abusaeeidx/Mrgify-BDIX-IPTV/main/playlist.m3u',
  // Free-TV: large international list, grouped by country.
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
  // NOTE: iptv-org's sports.m3u was evaluated (Setanta Sports, GolTV Latin
  // America) but everything worth adding from it turned out to be plain
  // http:// - blocked as mixed content on this https site - so it isn't
  // wired in. Re-add it here if a genuinely https, non-restream find turns
  // up in it later.
];

module.exports = { SOURCE_URLS };
