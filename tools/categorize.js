'use strict';
// ---------------------------------------------------------------------------
// Maps every channel into a two-level taxonomy: Category > Subcategory.
//
// The source playlists group channels by country (128 groups, mostly "Italy",
// "Greece", ...), which is useless for finding something to watch. This
// reclassifies by WHAT a channel shows, using its name first and its original
// group as a fallback.
//
// On sports leagues, an honest limit: a channel's name is the only signal
// available here. "Sky Sport Serie A" clearly carries Serie A; "Sky Sports Main
// Event" carries whatever is on today. So a channel is filed under a league
// only when its name says so, and general sports channels land in a
// catch-all rather than being guessed into a league they may not be showing.
// ---------------------------------------------------------------------------

const CATEGORY_ORDER_FIRST = ['Favourites'];

// --- helpers ---------------------------------------------------------------
const norm = (s) => String(s || '').toLowerCase();

function anyOf(hay, words) {
  return words.some((w) => hay.includes(w));
}

// --- sports leagues --------------------------------------------------------
// Only names that unambiguously identify a competition.
const LEAGUES = [
  ['Premier League', ['premier league', 'premierleague', 'epl ', ' epl', 'sky sports premier']],
  ['LaLiga', ['laliga', 'la liga', 'liga de campeones', 'movistar laliga', 'gol tv', 'goltv']],
  ['Serie A', ['serie a', 'seriea', 'sky sport serie', 'dazn 1', 'zona dazn']],
  ['Bundesliga', ['bundesliga']],
  ['Ligue 1', ['ligue 1', 'ligue1']],
  ['Champions League', ['champions league', 'uefa', 'europa league', 'golazo', 'conference league']],
];

const CRICKET = [
  'cricket', 'willow', 'star sports', 'ten sports', 'ptv sports', 't sports',
  't-sports', 'tsports', 'a sports', 'astro cricket', 'fox cricket', 'sony ten',
  'super sport cricket', 'ary zap',
];

const MOTORSPORT = ['motorsport', 'formula 1', ' f1', 'f1 ', 'motogp', 'nascar', 'rally', 'motor vision', 'redbull tv'];
const COMBAT = ['ufc', 'wwe', 'boxing', 'mma', 'fight'];
const US_SPORTS = ['nba', 'nfl', 'nhl', 'mlb', 'espn', 'fanduel', 'draftkings', 'pac-12', 'pac 12'];
const FOOTBALL_GENERIC = ['football', 'futbol', 'fútbol', 'futebol', 'soccer', 'calcio', 'fussball'];
const SPORT_GENERIC = [
  'sport', 'sports', 'spor', 'deporte', 'sportklub', 'eurosport', 'supersport',
  'bein', 'bein sports', 'sky sport', 'tnt sport', 'premier sports', 'viaplay',
  'dazn', 'setanta', 'arena sport', 'nova sport', 'match!', 'sport1',
];

// --- other themes ----------------------------------------------------------
const KIDS = [
  'cartoon', 'kids', 'nick', 'disney', 'baby', 'boomerang', 'pogo', 'cbeebies',
  'junior', 'toon', 'anime', 'doraemon', 'tom & jerry', 'tom and jerry',
  'motu patlu', 'mr bean', 'sony yay', 'discovery kids', 'pbs kids', 'da vinci',
];
const MUSIC = [
  'music', 'mtv', 'vh1', 'musik', 'musica', 'música', 'muzik', 'hits', 'radio',
  'fm ', ' fm', 'b4u music', 'zing', 'yrf', 'mastii', '9xm', 'sangeet', 'classic fm',
];
const MOVIES = [
  'movie', 'movies', 'cinema', 'cine', 'film', 'filme', 'pictures', 'hbo',
  'starz', 'moviestar', 'bflix', 'goldmines', 'zee cinema', 'sony max',
  'sony pix', '& pictures', 'zee action', 'zee bollywood', 'b4u movies',
  'action hollywood', 'south movies', 'hindi movies',
];
const NEWS = [
  'news', 'noticias', 'haber', 'nachrichten', 'cnn', 'bbc news', 'aljazeera',
  'al jazeera', 'sky news', 'france 24', 'dw ', 'rt ', 'ndtv', 'trt world',
  'euronews', 'bloomberg', 'cnbc', 'abc news', 'fox news', 'msnbc', 'gb news',
  'i24', 'trt haber', 'ekhon', 'somoy', 'jamuna', 'independent tv', 'channel 24',
];
const BUSINESS = ['business', 'bloomberg', 'cnbc', 'money', 'markets', 'forbes'];
const RELIGION = [
  'islamic', 'quran', 'qur’an', 'madani', 'peace tv', 'islam', 'iqraa',
  'sunnah', 'mecca', 'makkah', 'medina', 'ewtn', 'god tv', 'daystar', 'church',
  'christian', 'gospel', 'bhakti', 'aastha', 'sanskar', 'religion', 'religi',
  'al qamar', 'al istiqama', 'bahrain quran', 'saudia arabia', 'tbn',
];
const DOCUMENTARY = [
  'discovery', 'national geographic', 'nat geo', 'history', 'animal planet',
  'documentar', 'docu', 'tlc', 'travel', 'science', 'wild', 'nature',
  'investigation', 'crime', 'bbc earth', 'insight', 'curiosity', 'viasat',
];
const WEATHER = ['weather', 'meteo', 'clima'];

// Bangladesh-facing groups from the BDIX playlist.
const BD_GROUPS = [
  '[live] bdix', 'bangla', 'bangladeshi', 'kolkata bangla', 'indian-bangla',
  'indian bangla news', 'akash go',
];

// Groups that are explicitly video-on-demand rather than live TV.
const VOD_GROUPS = ['vod italy', 'vod movies'];

/**
 * @returns {{category: string, subcategory: string}}
 */
function classify(channel) {
  const name = norm(channel.name);
  const group = norm(channel.group);
  const both = name + ' ' + group;

  // --- video on demand -----------------------------------------------------
  if (anyOf(group, VOD_GROUPS)) {
    return { category: 'On Demand', subcategory: group.includes('italy') ? 'Italy' : 'Movies' };
  }

  // --- sports (checked early: sports channels hide inside country groups) ---
  const looksSport =
    anyOf(name, SPORT_GENERIC) || anyOf(name, FOOTBALL_GENERIC) ||
    anyOf(name, CRICKET) || anyOf(name, MOTORSPORT) || anyOf(name, COMBAT) ||
    anyOf(name, US_SPORTS) || group === 'sports' || group === 'football' ||
    group === 'cricket ' || group === 'cricket' || group === 'live sports' ||
    group === 'live event';

  if (looksSport) {
    // One-off fixtures ("Team A vs Team B - 25 Aug 2026 - Some Trophy") are
    // events, not channels: they expire within days and their tournament name
    // otherwise lands them in the wrong league (a cricket "JITO Premier
    // League" is not the EPL). Keep them together and out of the league tabs.
    if (/\bvs\b/.test(name) || /\b\d{1,2}\s+\w{3}\s+20\d\d\b/.test(name) ||
        /\b\d(?:st|nd|rd|th)\s+test\b/.test(name) || /\bodi\b|\bt20\b/.test(name)) {
      return { category: 'Sports', subcategory: 'Live Events' };
    }
    for (const [league, words] of LEAGUES) {
      if (anyOf(name, words)) return { category: 'Sports', subcategory: league };
    }
    if (anyOf(name, CRICKET) || group.trim() === 'cricket') {
      return { category: 'Sports', subcategory: 'Cricket' };
    }
    if (anyOf(name, MOTORSPORT)) return { category: 'Sports', subcategory: 'Motorsport' };
    if (anyOf(name, COMBAT)) return { category: 'Sports', subcategory: 'Combat Sports' };
    if (anyOf(name, US_SPORTS)) return { category: 'Sports', subcategory: 'US Sports' };
    if (anyOf(name, FOOTBALL_GENERIC) || group === 'football') {
      return { category: 'Sports', subcategory: 'Football' };
    }
    return { category: 'Sports', subcategory: 'All Sports' };
  }

  // --- kids ----------------------------------------------------------------
  if (anyOf(name, KIDS) || group.includes('kids') || group.includes('cartoon')) {
    return { category: 'Kids', subcategory: anyOf(name, ['anime', 'doraemon', 'toon']) ? 'Animation' : 'Cartoons' };
  }

  // --- movies --------------------------------------------------------------
  if (anyOf(name, MOVIES) || group.includes('movie') || group.includes('cinema')) {
    let sub = 'General';
    if (anyOf(both, ['hindi', 'bollywood', 'zee', 'sony max', 'b4u', 'goldmines'])) sub = 'Hindi';
    else if (anyOf(both, ['bangla'])) sub = 'Bangla';
    else if (anyOf(both, ['south', 'tamil', 'telugu'])) sub = 'South Asian';
    else if (anyOf(both, ['english', 'hollywood', 'hbo', 'starz'])) sub = 'English';
    return { category: 'Movies', subcategory: sub };
  }

  // --- news ----------------------------------------------------------------
  if (anyOf(name, NEWS) || group.includes('news')) {
    if (anyOf(name, BUSINESS) || group.includes('business')) {
      return { category: 'News', subcategory: 'Business' };
    }
    let sub = 'World';
    if (anyOf(both, ['bangla', 'somoy', 'jamuna', 'ekhon', 'ntv', 'channel 24'])) sub = 'Bangladesh';
    else if (group.includes('(ar)') || anyOf(both, ['arab', 'al jazeera', 'aljazeera'])) sub = 'Arabic';
    else if (group.includes('(es)')) sub = 'Spanish';
    else if (anyOf(both, ['india', 'ndtv', 'hindi'])) sub = 'India';
    return { category: 'News', subcategory: sub };
  }

  // --- business (non-news) --------------------------------------------------
  if (anyOf(name, BUSINESS) || group === 'business') {
    return { category: 'News', subcategory: 'Business' };
  }

  // --- music ---------------------------------------------------------------
  if (anyOf(name, MUSIC) || group.includes('music') || group.includes('redio') || group.includes('radio')) {
    let sub = 'General';
    if (anyOf(both, ['hindi', 'bollywood', 'yrf', 'mastii', 'zing', 'b4u', '9xm'])) sub = 'Hindi';
    else if (anyOf(both, ['bangla'])) sub = 'Bangla';
    else if (anyOf(both, ['radio', 'fm'])) sub = 'Radio';
    return { category: 'Music', subcategory: sub };
  }

  // --- religion ------------------------------------------------------------
  if (anyOf(name, RELIGION) || group.includes('islamic') || group.includes('relagion') || group.includes('religion')) {
    let sub = 'Other';
    if (anyOf(both, ['islam', 'quran', 'madani', 'iqraa', 'sunnah', 'makkah', 'mecca', 'peace tv', 'al qamar', 'al istiqama'])) sub = 'Islamic';
    else if (anyOf(both, ['ewtn', 'god tv', 'daystar', 'church', 'christian', 'gospel', 'tbn'])) sub = 'Christian';
    else if (anyOf(both, ['bhakti', 'aastha', 'sanskar'])) sub = 'Hindu';
    return { category: 'Religion', subcategory: sub };
  }

  // --- documentary ---------------------------------------------------------
  if (anyOf(name, DOCUMENTARY) || group.includes('documentar') || group.includes('infotainment')) {
    let sub = 'General';
    if (anyOf(name, ['animal', 'wild', 'nature', 'planet'])) sub = 'Nature';
    else if (anyOf(name, ['science', 'curiosity'])) sub = 'Science';
    else if (anyOf(name, ['history'])) sub = 'History';
    else if (anyOf(name, ['travel'])) sub = 'Travel';
    else if (anyOf(name, ['crime', 'investigation'])) sub = 'Crime';
    return { category: 'Documentary', subcategory: sub };
  }

  // --- weather -------------------------------------------------------------
  if (anyOf(name, WEATHER) || group === 'weather') {
    return { category: 'Lifestyle', subcategory: 'Weather' };
  }

  // --- Bangladesh ----------------------------------------------------------
  if (anyOf(group, BD_GROUPS) || name.startsWith('[bd]')) {
    return { category: 'Bangladesh', subcategory: 'General' };
  }

  // --- entertainment -------------------------------------------------------
  if (group.includes('entertainment') || group.includes('drama') || group.includes('information')) {
    return { category: 'Entertainment', subcategory: 'General' };
  }

  // --- fallback: keep the original grouping as a country/region ------------
  const country = String(channel.group || 'Other').trim();
  return { category: 'Countries', subcategory: country || 'Other' };
}

/**
 * Builds the ordered category tree for the UI.
 * Categories A-Z, subcategories A-Z, with Favourites pinned first by the UI.
 */
function buildTree(channels) {
  const cats = new Map();
  for (const c of channels) {
    if (!cats.has(c.category)) cats.set(c.category, new Map());
    const subs = cats.get(c.category);
    subs.set(c.subcategory, (subs.get(c.subcategory) || 0) + 1);
  }

  const out = [...cats.entries()]
    .map(([category, subs]) => ({
      category,
      total: [...subs.values()].reduce((a, b) => a + b, 0),
      subcategories: [...subs.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

  return out;
}

module.exports = { classify, buildTree, CATEGORY_ORDER_FIRST };
