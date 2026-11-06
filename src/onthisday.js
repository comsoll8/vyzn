// src/onthisday.js
// "On This Day" Home shelf: films from the library that belong to today's
// date. Three sources, in this order:
//   1. Exact dates a film is set on or famous for (V for Vendetta on 5 Nov).
//   2. Seasons/holidays (Christmas films through December, horror for
//      Halloween week, ...).
//   3. Release anniversaries — any matched film released on today's
//      month/day in an earlier year.
// Only films actually in the library are returned; an empty list means the
// frontend simply doesn't draw the shelf.
//
// "Today" is the server's local date, so set TZ on the container (the
// Unraid template and docker-compose.yml both expose it) — otherwise the
// shelf flips over at midnight UTC.
//
// The curated lists match on TMDB title + release year (±1, since regional
// release years differ), not TMDB ids, so a typo here can only cause a
// miss, never put the wrong film on the shelf. To add one: copy a line,
// use the title exactly as TMDB lists it.

const db = require('./db');
const tmdb = require('./tmdb');
const { mapWithConcurrency } = require('./concurrency');

// --- Curated calendar ------------------------------------------------------

// [ 'MM-DD', title, year, reason ]
const DATES = [
  ['01-01', 'The Poseidon Adventure', 1972, 'Capsized at the stroke of New Year'],
  ['02-02', 'Groundhog Day', 1993, 'Groundhog Day. Again.'],
  ['02-29', 'Leap Year', 2010, 'A proposal that only works on 29 February'],
  ['03-14', 'Pi', 1998, 'Pi Day (3.14)'],
  ['03-24', 'The Breakfast Club', 1985, 'Saturday detention, 24 March 1984'],
  ['04-06', '1917', 2019, 'Set on 6 April 1917'],
  ['04-13', 'Apollo 13', 1995, 'The explosion, 13 April 1970'],
  ['04-14', 'Titanic', 1997, 'The iceberg, night of 14 April 1912'],
  ['04-15', 'Titanic', 1997, 'Titanic sank in the early hours of 15 April 1912'],
  ['04-25', 'Gallipoli', 1981, 'Anzac Day'],
  ['05-12', 'The Terminator', 1984, 'The Terminator arrives, May 1984'],
  ['06-06', 'Saving Private Ryan', 1998, 'D-Day, 6 June 1944'],
  ['06-06', 'The Longest Day', 1962, 'D-Day, 6 June 1944'],
  ['07-04', 'Independence Day', 1996, 'Fourth of July'],
  ['07-04', 'Jaws', 1975, "Amity's Fourth of July weekend"],
  ['07-04', 'Born on the Fourth of July', 1989, 'Fourth of July'],
  ['07-20', 'Apollo 11', 2019, 'Moon landing, 20 July 1969'],
  ['07-20', 'First Man', 2018, 'Moon landing, 20 July 1969'],
  ['08-29', 'Terminator 2: Judgment Day', 1991, 'Judgment Day, 29 August 1997'],
  ['10-21', 'Back to the Future Part II', 1989, 'Marty arrives in the future: 21 October 2015'],
  ['10-26', 'Back to the Future', 1985, 'Marty hits 88 mph, 26 October 1985'],
  ['10-30', 'Donnie Darko', 2001, 'The world ends 30 October 1988'],
  ['11-05', 'V for Vendetta', 2006, 'Remember, remember the fifth of November'],
  ['11-05', 'Back to the Future', 1985, 'Doc dreams up the flux capacitor, 5 November 1955'],
  ['11-05', 'Back to the Future Part III', 1990, 'Picks up on 5 November 1955'],
  ['11-11', 'All Quiet on the Western Front', 2022, 'Armistice Day, 11 November 1918'],
  ['12-21', '2012', 2009, 'The 21 December 2012 apocalypse'],
  ['12-24', 'Die Hard', 1988, 'Christmas Eve at Nakatomi Plaza'],
  ['12-31', "When Harry Met Sally...", 1989, "New Year's Eve"],
  ['12-31', 'Strange Days', 1995, "New Year's Eve, 1999"],
  ['12-31', "New Year's Eve", 2011, "New Year's Eve"],
];

// Film groups reused by several fan days below.
// Film entry: [title, year, ...alternate titles TMDB has used]
const STAR_WARS = [
  ['Star Wars', 1977, 'Star Wars: Episode IV - A New Hope'],
  ['The Empire Strikes Back', 1980, 'Star Wars: Episode V - The Empire Strikes Back'],
  ['Return of the Jedi', 1983, 'Star Wars: Episode VI - Return of the Jedi'],
  ['Star Wars: Episode I - The Phantom Menace', 1999],
  ['Star Wars: Episode II - Attack of the Clones', 2002],
  ['Star Wars: Episode III - Revenge of the Sith', 2005],
  ['Star Wars: The Force Awakens', 2015],
  ['Star Wars: The Last Jedi', 2017],
  ['Star Wars: The Rise of Skywalker', 2019],
  ['Rogue One: A Star Wars Story', 2016],
  ['Solo: A Star Wars Story', 2018],
  ['Star Wars: The Clone Wars', 2008],
];
const HARRY_POTTER = [
  ["Harry Potter and the Philosopher's Stone", 2001, "Harry Potter and the Sorcerer's Stone"],
  ['Harry Potter and the Chamber of Secrets', 2002],
  ['Harry Potter and the Prisoner of Azkaban', 2004],
  ['Harry Potter and the Goblet of Fire', 2005],
  ['Harry Potter and the Order of the Phoenix', 2007],
  ['Harry Potter and the Half-Blood Prince', 2009],
  ['Harry Potter and the Deathly Hallows: Part 1', 2010],
  ['Harry Potter and the Deathly Hallows: Part 2', 2011],
  ['Fantastic Beasts and Where to Find Them', 2016],
];
const MIDDLE_EARTH = [
  ['The Lord of the Rings: The Fellowship of the Ring', 2001],
  ['The Lord of the Rings: The Two Towers', 2002],
  ['The Lord of the Rings: The Return of the King', 2003],
  ['The Hobbit: An Unexpected Journey', 2012],
  ['The Hobbit: The Desolation of Smaug', 2013],
  ['The Hobbit: The Battle of the Five Armies', 2014],
  ['The Lord of the Rings: The War of the Rohirrim', 2024],
];
const STAR_TREK = [
  ['Star Trek: The Motion Picture', 1979], ['Star Trek II: The Wrath of Khan', 1982],
  ['Star Trek III: The Search for Spock', 1984], ['Star Trek IV: The Voyage Home', 1986],
  ['Star Trek V: The Final Frontier', 1989], ['Star Trek VI: The Undiscovered Country', 1991],
  ['Star Trek: Generations', 1994], ['Star Trek: First Contact', 1996],
  ['Star Trek: Insurrection', 1998], ['Star Trek: Nemesis', 2002],
  ['Star Trek', 2009], ['Star Trek Into Darkness', 2013], ['Star Trek Beyond', 2016],
];
const ALIEN = [
  ['Alien', 1979], ['Aliens', 1986], ['Alien³', 1992, 'Alien 3'], ['Alien Resurrection', 1997],
  ['Prometheus', 2012], ['Alien: Covenant', 2017], ['Alien: Romulus', 2024],
];
const BACK_TO_THE_FUTURE = [
  ['Back to the Future', 1985], ['Back to the Future Part II', 1989], ['Back to the Future Part III', 1990],
];
const PIRATES = [
  ['Pirates of the Caribbean: The Curse of the Black Pearl', 2003],
  ["Pirates of the Caribbean: Dead Man's Chest", 2006],
  ["Pirates of the Caribbean: At World's End", 2007],
  ['Pirates of the Caribbean: On Stranger Tides', 2011],
  ['Pirates of the Caribbean: Dead Men Tell No Tales', 2017],
  ['Hook', 1991], ['The Goonies', 1985], ['Treasure Planet', 2002],
];
const CHRISTMAS = [
  ['Home Alone', 1990], ['Home Alone 2: Lost in New York', 1992], ['Elf', 2003], ['Love Actually', 2003],
  ["It's a Wonderful Life", 1946], ['The Polar Express', 2004], ["National Lampoon's Christmas Vacation", 1989],
  ['The Nightmare Before Christmas', 1993], ['Die Hard', 1988], ['Klaus', 2019], ['The Holiday', 2006],
  ['Gremlins', 1984], ['Miracle on 34th Street', 1947], ['Miracle on 34th Street', 1994],
  ['The Muppet Christmas Carol', 1992], ['How the Grinch Stole Christmas', 2000], ['The Grinch', 2018],
  ['Arthur Christmas', 2011], ['Jingle All the Way', 1996], ['The Santa Clause', 1994],
  ['Bad Santa', 2003], ['Scrooged', 1988], ['A Christmas Story', 1983], ['Krampus', 2015],
  ['The Night Before', 2015], ['Last Christmas', 2019], ['Violent Night', 2022],
];
const FRIDAY_13TH = [
  ['Friday the 13th', 1980], ['Friday the 13th Part 2', 1981], ['Friday the 13th Part III', 1982],
  ['Friday the 13th: The Final Chapter', 1984], ['Friday the 13th: A New Beginning', 1985],
  ['Friday the 13th Part VI: Jason Lives', 1986], ['Friday the 13th Part VII: The New Blood', 1988],
  ['Friday the 13th Part VIII: Jason Takes Manhattan', 1989], ['Jason Goes to Hell: The Final Friday', 1993],
  ['Jason X', 2001], ['Freddy vs. Jason', 2003], ['Friday the 13th', 2009],
];

// Fan days and in-universe dates: { date: 'MM-DD', reason, films }.
// Same priority as DATES (exact-date picks, eligible for the hero).
const FAN_DAYS = [
  { date: '02-27', reason: 'Pokémon Day', films: [['Pokémon Detective Pikachu', 2019]] },
  { date: '03-09', reason: "Barbie's birthday", films: [['Barbie', 2023]] },
  { date: '03-10', reason: 'MAR10 Day', films: [['The Super Mario Bros. Movie', 2023], ['Super Mario Bros.', 1993], ['The Super Mario Galaxy Movie', 2026]] },
  { date: '03-25', reason: 'Tolkien Reading Day: the Ring is destroyed', films: MIDDLE_EARTH },
  { date: '04-05', reason: 'First Contact Day', films: [['Star Trek: First Contact', 1996]] },
  { date: '04-26', reason: 'Alien Day (LV-426)', films: ALIEN },
  { date: '05-02', reason: 'The Battle of Hogwarts', films: [['Harry Potter and the Deathly Hallows: Part 2', 2011]] },
  { date: '05-04', reason: 'May the 4th be with you', films: STAR_WARS },
  { date: '05-05', reason: 'Revenge of the Fifth', films: [['Star Wars: Episode III - Revenge of the Sith', 2005], ['Rogue One: A Star Wars Story', 2016], ['Solo: A Star Wars Story', 2018]] },
  { date: '05-25', reason: 'Towel Day', films: [["The Hitchhiker's Guide to the Galaxy", 2005]] },
  { date: '06-12', reason: 'Superman Day', films: [['Superman', 1978], ['Superman II', 1980], ['Superman Returns', 2006], ['Man of Steel', 2013], ['Superman', 2025]] },
  { date: '06-23', reason: "Sonic's birthday", films: [['Sonic the Hedgehog', 2020], ['Sonic the Hedgehog 2', 2022], ['Sonic the Hedgehog 3', 2024]] },
  { date: '07-25', reason: 'Christmas in July', films: CHRISTMAS },
  { date: '07-31', reason: "Harry Potter's birthday", films: HARRY_POTTER },
  { date: '09-01', reason: 'The Hogwarts Express leaves King\'s Cross', films: HARRY_POTTER },
  { date: '09-08', reason: 'Star Trek Day', films: STAR_TREK },
  { date: '09-19', reason: 'Talk Like a Pirate Day', films: PIRATES },
  { date: '09-22', reason: "Hobbit Day: Bilbo and Frodo's birthday", films: MIDDLE_EARTH },
  { date: '10-03', reason: 'Mean Girls Day: it\'s October 3rd', films: [['Mean Girls', 2004], ['Mean Girls', 2024]] },
  { date: '10-21', reason: 'Back to the Future Day', films: BACK_TO_THE_FUTURE },
  { date: '11-03', reason: 'Godzilla Day', films: [['Godzilla', 1954], ['Godzilla', 2014], ['Shin Godzilla', 2016], ['Godzilla Minus One', 2023], ['Godzilla vs. Kong', 2021]] },
];

// Dates that move: { test(date) -> bool, reason, films }.
const RULES = [
  { test: (d) => d.getDay() === 5 && d.getDate() === 13, reason: 'Friday the 13th', films: FRIDAY_13TH },
];

// { from, to, reason, films: [[title, year], ...] } — inclusive MM-DD
// window; a window may wrap the year end (from '12-26' to '01-02').
const SEASONS = [
  {
    from: '02-07', to: '02-14', reason: "Valentine's Day",
    films: [['Valentine\'s Day', 2010], ['Crazy, Stupid, Love.', 2011], ['Notting Hill', 1999], ['The Notebook', 2004], ['Love Actually', 2003]],
  },
  {
    from: '06-14', to: '06-24', reason: 'Midsummer',
    films: [['Midsommar', 2019]],
  },
  {
    from: '10-15', to: '10-31', reason: 'Halloween',
    films: [
      ['Halloween', 1978], ['Halloween', 2018], ['Hocus Pocus', 1993], ['Trick \'r Treat', 2007],
      ['The Nightmare Before Christmas', 1993], ['Beetlejuice', 1988], ['Coraline', 2009],
      ['It', 2017], ['The Exorcist', 1973], ['Scream', 1996], ['A Nightmare on Elm Street', 1984],
      ['Ghostbusters', 1984], ['The Addams Family', 1991], ['ParaNorman', 2012],
    ],
  },
  {
    from: '10-31', to: '11-02', reason: 'Día de Muertos',
    films: [['Coco', 2017], ['The Book of Life', 2014]],
  },
  {
    from: '12-01', to: '12-26', reason: 'Christmas',
    films: CHRISTMAS,
  },
  {
    from: '12-26', to: '01-01', reason: "New Year's",
    films: [['When Harry Met Sally...', 1989], ['The Apartment', 1960], ['Trading Places', 1983], ['Ocean\'s Eleven', 2001]],
  },
];

// --- Matching ----------------------------------------------------------------

function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function pad2(n) { return String(n).padStart(2, '0'); }

function todayParts(now = new Date()) {
  return { year: now.getFullYear(), md: `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` };
}

function inWindow(md, from, to) {
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}

// Curated hits for one MM-DD: [{ title, year, reason, priority }]
function curatedFor(md, now = new Date()) {
  const out = [];
  const add = (films, reason, priority) => {
    for (const [title, year, ...alts] of films) out.push({ titles: [title, ...alts], year, reason, priority });
  };
  for (const [date, title, year, reason] of DATES) {
    if (date === md) add([[title, year]], reason, 0);
  }
  for (const f of FAN_DAYS) if (f.date === md) add(f.films, f.reason, 0);
  for (const r of RULES) if (r.test(now)) add(r.films, r.reason, 0);
  for (const s of SEASONS) if (inWindow(md, s.from, s.to)) add(s.films, s.reason, 1);
  return out;
}

const MOVIE_COLS = `
  m.*, p.completed, 'movie' AS kind
  FROM media_items m
  LEFT JOIN playback_progress p ON p.media_id = m.id AND p.profile_id = @profileId
  WHERE m.media_type = 'movie' AND m.tmdb_id IS NOT NULL
`;

/**
 * Today's "On This Day" movies for a profile (unfiltered by rating — the
 * caller applies filterByProfile/dedupeMovies like every other shelf).
 * Each row carries `otd_reason` for the caption under the poster.
 */
function buildOnThisDay(profileId, { now = new Date(), limit = 20 } = {}) {
  const { year: thisYear, md } = todayParts(now);
  const out = [];
  const seen = new Set(); // tmdb_id

  const push = (row, reason) => {
    if (!row || seen.has(row.tmdb_id)) return;
    seen.add(row.tmdb_id);
    out.push({ ...row, otd_reason: reason });
  };

  // 1 + 2: curated. One pass over the library builds a title|year index.
  const curated = curatedFor(md, now);
  if (curated.length) {
    const byKey = new Map();
    for (const row of db.prepare(`SELECT ${MOVIE_COLS}`).all({ profileId })) {
      const key = normTitle(row.tmdb_matched_title || row.title);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    }
    curated.sort((a, b) => a.priority - b.priority);
    for (const c of curated) {
      const candidates = c.titles.flatMap((t) => byKey.get(normTitle(t)) || []);
      const hit = candidates.find((r) => r.release_year && Math.abs(r.release_year - c.year) <= 1);
      if (hit) push(hit, c.reason);
    }
  }

  // 3: release anniversaries, round numbers (10, 25, 40...) first.
  const anniversaries = db.prepare(`
    SELECT ${MOVIE_COLS}
      AND m.release_date LIKE @pattern
      AND CAST(substr(m.release_date, 1, 4) AS INTEGER) < @thisYear
    ORDER BY m.rating DESC
  `).all({ profileId, pattern: `____-${md}`, thisYear });
  const yearsAgo = (r) => thisYear - parseInt(r.release_date.slice(0, 4), 10);
  const roundness = (n) => (n % 25 === 0 ? 0 : n % 10 === 0 ? 1 : n % 5 === 0 ? 2 : 3);
  anniversaries.sort((a, b) => roundness(yearsAgo(a)) - roundness(yearsAgo(b)));
  for (const row of anniversaries) {
    const n = yearsAgo(row);
    push(row, n === 1 ? 'Released a year ago today' : `Released ${n} years ago today`);
  }

  return out.slice(0, limit * 2); // headroom for the caller's rating filter
}

// --- Release-date backfill ----------------------------------------------------

// Films matched before release_date existed have it NULL. Fill them in once,
// quietly, in the background at startup — one small TMDB call per film. A
// failed call leaves the row NULL so the next start retries it; a film TMDB
// has no date for gets '' so it's never asked about again.
async function backfillReleaseDates(log = console) {
  if (!tmdb.isConfigured()) return;
  const rows = db.prepare(`
    SELECT DISTINCT tmdb_id FROM media_items
    WHERE media_type = 'movie' AND tmdb_id IS NOT NULL AND release_date IS NULL
  `).all();
  if (!rows.length) return;
  log.info(`[onthisday] Backfilling release dates for ${rows.length} movies...`);
  const save = db.prepare(`UPDATE media_items SET release_date = ? WHERE tmdb_id = ? AND media_type = 'movie'`);
  let filled = 0;
  await mapWithConcurrency(rows, 4, async ({ tmdb_id: id }) => {
    try {
      save.run(await tmdb.getMovieReleaseDate(id), id);
      filled += 1;
    } catch (err) {
      // leave NULL, retried on next start
    }
  });
  log.info(`[onthisday] Release-date backfill done (${filled}/${rows.length}).`);
}

module.exports = { buildOnThisDay, backfillReleaseDates, curatedFor, normTitle, _DATES: DATES, _SEASONS: SEASONS, _FAN_DAYS: FAN_DAYS };
