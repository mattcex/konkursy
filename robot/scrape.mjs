// Robot: pobiera aktualne konkursy z e-konkursy.info, dokłada konkursy znalezione w innych miejscach
// (data/curated.json, wpisy „web:…”) i rozdania z Instagrama (gdy jest sekret APIFY_TOKEN),
// a potem zapisuje site/data/contests.json.
// Uruchamiany codziennie przez GitHub Actions (.github/workflows/robot.yml) albo ręcznie: npm run scrape

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { classify, parsePrizeCount, parseResultsDate, platformOf, todayISO, diffDays } from '../site/logic.js';
import { parseListing, parseDetail, hasNextPage, locationFromTitle } from './parse.mjs';
import { fetchHashtagPosts, mergeInstagram, DEFAULT_HASHTAGS, DEFAULT_LIMIT } from './instagram.mjs';

const BASE = 'https://www.e-konkursy.info';
// Listy kategorii (konkursy-promocyjne = loterie i konkursy marek, tam są auta i nagrody pieniężne).
const LISTS = [
  'konkursy/konkursy-aktualne',
  'konkursy/konkursy-na-facebooku',
  'konkursy/konkursy-instagram',
  'konkursy/konkursy-social-media',
  'konkursy/konkursy-na-blogach',
  'konkursy/konkursy-lokalne',
  'konkursy/konkursy-promocyjne',
];
// Tagi zainteresowań („Dla Ciebie”): przeszukiwane osobno, żeby nie umknęły poza pierwszymi stronami list.
const TAGS = ['narty', 'snowboard', 'gory', 'zakopane', 'samochod', 'auto', 'fujifilm', 'instax', 'aparat', 'gotowka', 'pieniadze', 'wyjazd'];
const MAX_PAGES = Number(process.env.MAX_PAGES || 8);
const MAX_TAG_PAGES = Number(process.env.MAX_TAG_PAGES || 3);
const MAX_DETAILS = Number(process.env.MAX_DETAILS || 250);
const DELAY_MS = Number(process.env.DELAY_MS || 700);
const REFRESH_DAYS = 5; // co ile dni odświeżać opis znanego konkursu
const KEEP_DAYS = 45; // ile dni po zakończeniu trzymać konkurs na liście
const KEEP_IG_DAYS = 7; // to samo dla rozdań z Instagrama

const repoUrl = process.env.GITHUB_REPOSITORY ? `https://github.com/${process.env.GITHUB_REPOSITORY}` : 'https://github.com';
const UA = `LootsyBot/1.0 (+${repoUrl})`;

const OUT = new URL('../site/data/contests.json', import.meta.url);
const CURATED = new URL('../data/curated.json', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJSON(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch {
    return fallback;
  }
}

async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pl-PL,pl;q=0.9' } });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
      console.warn(`HTTP ${res.status} ${url}`);
    } catch (e) {
      console.warn(`Błąd pobierania ${url}: ${e.message}`);
    }
    await sleep(1500 * attempt);
  }
  return null;
}

function stable(contests) {
  return JSON.stringify(contests);
}

/**
 * Ręczne uzupełnienia z data/curated.json:
 * - wpis o identyfikatorze konkursu z katalogu („ek:…”) poprawia jego pola (liczba komentarzy, gotowe odpowiedzi…),
 * - wpis „web:…” z tytułem i datą końca to konkurs znaleziony poza e-konkursy – trafia na listę w całości,
 * - „exclude: true” usuwa konkurs z listy (np. akcja tylko dla firm).
 */
export function applyCurated(byId, curated, today) {
  for (const [id, extra] of Object.entries(curated || {})) {
    if (!extra || typeof extra !== 'object' || id.startsWith('_')) continue;
    if (extra.exclude === true) {
      byId.delete(id);
      continue;
    }
    let c = byId.get(id);
    if (!c) {
      if (!id.startsWith('web:') || !extra.title || !extra.end || diffDays(extra.end, today) > KEEP_DAYS) continue;
      const url = extra.url || '';
      const platform = extra.platform || platformOf(url);
      const { flags, judging } = classify({ title: extra.title, task: extra.task || '', prizes: extra.prizes || '', platform, cats: [] });
      c = {
        cats: [],
        id,
        title: extra.title,
        org: extra.org || '',
        url,
        src: extra.src || url,
        platform,
        start: extra.start || null,
        end: extra.end,
        results: parseResultsDate(extra.task || '', extra.end) || null,
        task: extra.task || '',
        prizes: extra.prizes || '',
        prizeCount: parsePrizeCount(extra.prizes || '') ?? 1,
        judging,
        location: extra.location || null,
        local: Boolean(extra.location),
        flags,
        comments: null,
        commentsAt: null,
        origin: 'web',
        firstSeen: today,
        seenAt: today,
        fetchedAt: today,
      };
      byId.set(id, c);
    }
    const { flags, comments, commentsAt, ...rest } = extra;
    Object.assign(c, rest);
    if (comments !== undefined && !(c.commentsAt && commentsAt && c.commentsAt > commentsAt)) {
      c.comments = comments;
      c.commentsAt = commentsAt || null;
    }
    if (flags && typeof flags === 'object') c.flags = { ...c.flags, ...flags };
  }
  return byId;
}

export async function scrape() {
  const today = todayISO();
  const prev = await readJSON(OUT, { contests: [] });
  const prevStable = stable(prev.contests || []); // zapamiętane przed zmianami (obiekty niżej są modyfikowane)
  const curated = await readJSON(CURATED, {});
  const byId = new Map((prev.contests || []).map((c) => [c.id, c]));

  // 1. Listy kategorii i tagi zainteresowań
  const slugs = new Set();
  const lists = [...LISTS.map((path) => [path, MAX_PAGES]), ...TAGS.map((tag) => [`tagi/${tag}`, MAX_TAG_PAGES])];
  for (const [path, maxPages] of lists) {
    for (let page = 1; page <= maxPages; page++) {
      const html = await get(`${BASE}/${path}${page > 1 ? `?strona=${page}` : ''}`);
      if (!html) break;
      const found = parseListing(html);
      found.forEach((s) => slugs.add(s));
      await sleep(DELAY_MS);
      if (!found.length || !hasNextPage(html, page)) break;
    }
  }
  console.log(`Na listach: ${slugs.size} konkursów.`);

  // 2. Szczegóły nowych i dawno nieodświeżanych konkursów
  let fetched = 0;
  let added = 0;
  for (const slug of slugs) {
    const id = `ek:${slug}`;
    const old = byId.get(id);
    if (old) old.seenAt = today;
    const stale = !old || !old.fetchedAt || diffDays(old.fetchedAt, today) >= REFRESH_DAYS;
    if (!stale || fetched >= MAX_DETAILS) continue;

    const html = await get(`${BASE}/konkurs/${slug}`);
    fetched++;
    await sleep(DELAY_MS);
    if (!html) continue;
    const d = parseDetail(html);
    if (!d.title || !d.end) continue;
    if (!old && diffDays(today, d.end) < 0) continue; // zakończony, zanim go zobaczyliśmy

    const url = d.url && /^https?:\/\//.test(d.url) ? d.url : `${BASE}/konkurs/${slug}`;
    const platform = platformOf(url);
    const { flags, judging } = classify({ title: d.title, task: d.task, prizes: d.prizes, platform, cats: d.cats });
    byId.set(id, {
      cats: d.cats,
      id,
      title: d.title,
      org: d.org || '',
      url,
      src: `${BASE}/konkurs/${slug}`,
      platform,
      start: d.start || null,
      end: d.end,
      results: parseResultsDate(d.task, d.end) || (old && old.results) || null,
      task: d.task,
      prizes: d.prizes,
      prizeCount: parsePrizeCount(d.prizes),
      judging,
      location: locationFromTitle(d.title) || (old && old.location) || null,
      local: d.cats.includes('konkursy-lokalne'),
      flags,
      comments: old ? old.comments ?? null : null,
      commentsAt: old ? old.commentsAt ?? null : null,
      firstSeen: (old && old.firstSeen) || today,
      seenAt: today,
      fetchedAt: today,
    });
    if (!old) added++;
  }
  console.log(`Pobrano opisy: ${fetched}, nowe konkursy: ${added}.`);

  // 2b. Instagram: najnowsze posty z #rozdanie i #konkurs (Apify), najwyżej raz dziennie – każde pobranie kosztuje
  let igFetchedAt = prev.igFetchedAt || null;
  const apifyToken = process.env.APIFY_TOKEN || '';
  if (!apifyToken) {
    console.log('Instagram: pominięty (brak sekretu APIFY_TOKEN).');
  } else if (igFetchedAt === today && process.env.IG_FORCE !== '1') {
    console.log('Instagram: już pobrany dzisiaj.');
  } else {
    const tags = (process.env.IG_HASHTAGS || '').split(/[\s,]+/).map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
    const hashtags = tags.length ? tags.slice(0, 5) : DEFAULT_HASHTAGS;
    const limit = Math.min(Math.max(Number(process.env.IG_LIMIT) || DEFAULT_LIMIT, 1), 50);
    igFetchedAt = today; // także po błędzie: uruchomienie w Apify mogło już kosztować
    try {
      const posts = await fetchHashtagPosts({ token: apifyToken, hashtags, limit });
      const r = mergeInstagram(byId, posts, today);
      const skipped = Object.entries(r.skipped).map(([k, n]) => `${k} ${n}`).join(', ') || 'brak';
      console.log(`Instagram: ${r.posts} postów, rozdania: ${r.found}, nowe: ${r.added}, odświeżone liczby komentarzy: ${r.updated}; pominięte: ${skipped}.`);
    } catch (e) {
      console.warn(`Instagram: nie udało się pobrać postów (${e.message}).`);
    }
  }

  // 3. Usunięcie dawno zakończonych i ponowna klasyfikacja zapisanych opisów
  //    (poprawki w site/logic.js działają od razu także dla starszych konkursów)
  for (const [id, c] of byId) {
    // Rozdań z Instagrama jest dużo, więc po terminie znikają szybciej (zgłoszenia zostają w Twojej sesji).
    if (c.end && diffDays(c.end, today) > (c.origin === 'ig' ? KEEP_IG_DAYS : KEEP_DAYS)) {
      byId.delete(id);
      continue;
    }
    if (!c.title) continue;
    const { flags, judging } = classify({ title: c.title, task: c.task || '', prizes: c.prizes || '', platform: c.platform, cats: c.cats || [] });
    c.flags = flags;
    c.judging = judging;
    c.prizeCount = parsePrizeCount(c.prizes) ?? c.prizeCount ?? 1;
    c.results = parseResultsDate(c.task, c.end) || null;
  }

  // 4. Ręczne uzupełnienia (data/curated.json): liczby komentarzy, gotowe odpowiedzi, konkursy spoza e-konkursy
  applyCurated(byId, curated, today);

  // 5. Zapis (tylko gdy coś się zmieniło)
  const contests = [...byId.values()].sort((a, b) => (a.end || '9999').localeCompare(b.end || '9999') || a.id.localeCompare(b.id));
  if (stable(contests) === prevStable && prev.since && (prev.igFetchedAt || null) === igFetchedAt) {
    console.log('Bez zmian.');
    return { changed: false, count: contests.length };
  }
  await mkdir(new URL('.', OUT), { recursive: true });
  // „since” = dzień pierwszego importu; konkursy z tego dnia nie są oznaczane w aplikacji jako „nowe”.
  const firstSeenDates = (prev.contests || []).map((c) => c.firstSeen).filter(Boolean).sort();
  const since = prev.since || firstSeenDates[0] || today;
  const source = `e-konkursy.info + data/curated.json${igFetchedAt ? ' + Instagram (Apify)' : ''}`;
  const data = { updatedAt: new Date().toISOString(), since, source, igFetchedAt, count: contests.length, contests };
  await writeFile(OUT, JSON.stringify(data, null, 1) + '\n', 'utf8');
  console.log(`Zapisano ${contests.length} konkursów.`);
  return { changed: true, count: contests.length };
}

if (process.argv[1] && process.argv[1].endsWith('scrape.mjs')) {
  scrape().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
