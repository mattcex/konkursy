// Rozdania z Instagrama: najnowsze posty z hashtagami #rozdanie i #konkurs.
// Posty pobiera Apify (aktor „Instagram Hashtag Scraper”) – tylko gdy w sekretach repozytorium jest APIFY_TOKEN.
// Koszt na planie darmowym: 0,0026 USD za post; domyślnie 2 × 25 postów raz dziennie ≈ 4 USD miesięcznie
// (Apify daje 5 USD darmowego limitu co miesiąc).

import { classify, parsePrizeCount, parseResultsDate, addDays, diffDays } from '../site/logic.js';

export const ACTOR = 'apify~instagram-hashtag-scraper';
export const DEFAULT_HASHTAGS = ['rozdanie', 'konkurs'];
export const DEFAULT_LIMIT = 25; // postów na hashtag
const PRICE_USD = 0.0026; // za jeden post (plan darmowy)
const GUESS_DAYS = 7; // termin, gdy w poście nie ma daty końca
const MAX_DAYS = 120; // dalsza data to raczej coś innego niż koniec rozdania
const MAX_AGE_DAYS = 10; // starsze posty pomijamy

const MONTHS = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6,
  lipca: 7, sierpnia: 8, września: 9, października: 10, listopada: 11, grudnia: 12,
};

const L_ = 'a-ząćęłńóśźż';
const GIVEAWAY_RX = /rozdani|konkurs|giveaway|do wygrania|wygraj|wygrać|nagrod/i;
const ENTRY_RX = /komentarz|komentuj|oznacz|obserwuj|zasad|warunk|udział|polub|zgłosz|odpowiedz|napisz/i;
// Ogłoszenia wyników i zakończone rozdania
const DONE_RX = new RegExp(
  [
    'wyniki\\s+(?:rozdania|konkursu|giveaway)',
    'zwycięzc\\w*\\s+(?:to|zostaje|zostają|zostali|jest|są)(?![' + L_ + '])',
    'gratul\\w*\\s+(?:dla\\s+)?@',
    '(?:rozdanie|konkurs|giveaway)\\s+(?:został[oa]?\\s+|jest\\s+)?zakończon',
    'zakończyliśmy',
    'wygrywa(?:ją)?\\s*:?\\s*@',
  ].join('|'),
  'i',
);
const PRIZE_STRONG_RX = /do wygrania|nagrod[aąyęi]|zestaw|voucher|(?:^|[^a-ząćęłńóśźż])bon(?:y|u|ów)?(?![a-ząćęłńóśźż])|kart[aęy] podarunkow|egzemplarz/i;
const PRIZE_WEAK_RX = /wygra|wygrywa/i;
const RULES_RX = /obserwuj|oznacz|komentarz|polub|udostępnij|zasad|warunk/i;
const POLISH_RX = /[ąęł]|rozdani/i;
// Data wyników, wysyłki lub odbioru nagród, urodziny („wyniki 2.12”, „nagrody wyślemy do 15.12”)
const SKIP_BEFORE_RX = /(?:wynik|ogłos|zwycięz|laureat|wysył|wyśl|odbi|odebra|urodzin)[^,;]{0,25}$/;

const pad = (n) => String(n).padStart(2, '0');
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** Kod posta z adresu Instagrama (/p/…, /reel/…, /tv/…) – do rozpoznawania tych samych postów. */
export function igCode(url) {
  const m = String(url || '').match(/instagram\.com\/(?:[^/?#]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

/** Tekst bez emoji, z „pogrubionymi” literami Unicode zamienionymi na zwykłe. */
export function cleanText(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/\r/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Data końca rozdania z opisu („trwa do 30.11”, „od 20.11 do 27.11”, „do 5 grudnia 2026”).
 * Pomija daty wyników i wysyłki nagród; z kilku pasujących wybiera najpóźniejszą.
 */
export function parseEndDate(text, postISO) {
  const t = String(text || '');
  const re = new RegExp(
    `(\\d{1,2})\\s*[./-]\\s*(\\d{1,2})(?:\\s*[./-]\\s*(\\d{2,4}))?(?![\\d:])|(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})(?:\\s+(\\d{4}))?`,
    'gi',
  );
  const keyword = new RegExp(`(?:^|[^${L_}])(?:do|trwa|kończy|koniec|końca|termin|czas|zgłoszenia|ważn)(?![${L_}])`);
  let best = null;
  let m;
  while ((m = re.exec(t))) {
    // Tylko bieżące zdanie przed datą (kropka w „30.11” nie kończy zdania).
    const before = t
      .slice(Math.max(0, m.index - 40), m.index)
      .toLowerCase()
      .split(/[\n!?]|\.\s/)
      .pop();
    if (SKIP_BEFORE_RX.test(before) || !keyword.test(before)) continue;
    let d, mo, y;
    if (m[4]) {
      d = +m[4];
      mo = MONTHS[m[5].toLowerCase()];
      y = m[6] ? +m[6] : null;
    } else {
      d = +m[1];
      mo = +m[2];
      y = m[3] ? +m[3] : null;
    }
    if (y !== null && y < 100) y += 2000;
    const explicitYear = y !== null;
    if (!explicitYear) y = +postISO.slice(0, 4);
    const date = new Date(Date.UTC(y, mo - 1, d, 12));
    if (!(mo >= 1 && mo <= 12) || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) continue;
    let iso = `${y}-${pad(mo)}-${pad(d)}`;
    if (!explicitYear && diffDays(postISO, iso) < -1) iso = `${y + 1}-${pad(mo)}-${pad(d)}`; // „do 5.01” w grudniu
    const days = diffDays(postISO, iso);
    if (days < 0 || days > MAX_DAYS) continue;
    if (!best || iso > best) best = iso;
  }
  return best;
}

/** Zdania o nagrodach (najpierw „do wygrania”, „nagroda”, „zestaw”…, potem ogólne „wygraj”). */
function prizeLines(text) {
  const lines = text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[\s•*·\-–—>]+|\s+$/g, '').replace(/#[^\s#]+/g, '').trim())
    .filter((s) => s.length >= 4);
  const strong = lines.filter((l) => PRIZE_STRONG_RX.test(l));
  const weak = lines.filter((l) => PRIZE_WEAK_RX.test(l) && !RULES_RX.test(l));
  return [...new Set([...strong, ...weak])].slice(0, 3).map((l) => cut(l, 200));
}

/** Post z Instagrama → konkurs w formacie listy (albo null, gdy to nie jest trwające rozdanie po polsku). */
export function parsePost(p, today) {
  if (!p || typeof p !== 'object' || p.error) return null;
  const url = typeof p.url === 'string' ? p.url : '';
  const code = p.shortCode || igCode(url);
  if (!code || !/^https:\/\/(www\.)?instagram\.com\//.test(url)) return null;
  if (p.isCommentsDisabled === true) return null;
  const text = cleanText(p.caption);
  if (text.length < 40 || !POLISH_RX.test(text) || !GIVEAWAY_RX.test(text) || !ENTRY_RX.test(text) || DONE_RX.test(text)) return null;

  const postISO = typeof p.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.timestamp) ? p.timestamp.slice(0, 10) : today;
  if (diffDays(postISO, today) > MAX_AGE_DAYS) return null;
  let end = parseEndDate(text, postISO);
  const endGuess = !end;
  if (!end) end = addDays(postISO, GUESS_DAYS);
  if (diffDays(today, end) < 0) return null; // już po terminie

  const prizes = prizeLines(text);
  const firstLine = text.split('\n').map((l) => l.replace(/#[^\s#]+/g, '').trim()).find((l) => l.length >= 4) || '';
  const subject =
    (prizes[0] || firstLine)
      .replace(/^.*?do wygrania(?:\s+(?:jest|są|mamy))?\s*:?\s*/i, '')
      .replace(/^(?:(?:rozdanie|konkurs|giveaway)\s*[:!.\-–—]*\s*)+/i, '') || firstLine;
  const kind = /konkurs/i.test(text) && !/rozdani|giveaway/i.test(text) ? 'Konkurs' : 'Rozdanie';
  const owner = typeof p.ownerUsername === 'string' && p.ownerUsername ? p.ownerUsername : '';
  const title = `${kind}${owner ? ` @${owner}` : ''}: ${cut(subject.replace(/\s+/g, ' '), 90)}`;
  // Opis bez linii złożonych z samych hashtagów
  const task = cut(
    text
      .split('\n')
      .filter((l) => !/^(?:[#@][^\s]+\s*)+$/.test(l.trim()))
      .join('\n')
      .trim(),
    2500,
  );
  const prizesText = prizes.map((l) => `• ${l}`).join('\n');
  const { flags, judging } = classify({ title, task, prizes: prizesText, platform: 'instagram', cats: [] });
  const comments = typeof p.commentsCount === 'number' && p.commentsCount >= 0 ? Math.round(p.commentsCount) : null;
  return {
    cats: [],
    id: `ig:${code}`,
    title,
    org: owner ? `@${owner}` : p.ownerFullName || '',
    url: url.replace(/[?#].*$/, ''),
    src: url.replace(/[?#].*$/, ''),
    platform: 'instagram',
    start: postISO,
    end,
    endGuess: endGuess || undefined,
    results: parseResultsDate(task, end) || null,
    task,
    prizes: prizesText,
    prizeCount: parsePrizeCount(prizesText) ?? 1,
    judging,
    location: null,
    local: false,
    flags,
    comments,
    commentsAt: comments === null ? null : today,
    origin: 'ig',
    firstSeen: today,
    seenAt: today,
    fetchedAt: today,
  };
}

/**
 * Dokłada rozdania do listy. Post, który już jest na liście (także z e-konkursy z tym samym adresem),
 * dostaje tylko świeżą liczbę komentarzy.
 */
export function mergeInstagram(byId, posts, today) {
  const byCode = new Map();
  for (const c of byId.values()) {
    const code = igCode(c.url);
    if (code) byCode.set(code, c);
  }
  const stats = { posts: (posts || []).length, found: 0, added: 0, updated: 0 };
  for (const p of posts || []) {
    const c = parsePost(p, today);
    if (!c) continue;
    stats.found++;
    const code = igCode(c.url);
    const old = byCode.get(code) || byId.get(c.id);
    if (old) {
      if (c.comments !== null && !(old.commentsAt && old.commentsAt > today)) {
        old.comments = c.comments;
        old.commentsAt = today;
        stats.updated++;
      }
      old.seenAt = today;
      continue;
    }
    if (!c.endGuess) delete c.endGuess;
    byId.set(c.id, c);
    byCode.set(code, c);
    stats.added++;
  }
  return stats;
}

/** Najnowsze posty z hashtagów przez Apify (jedno uruchomienie, czeka na wynik do ~5 minut). */
export async function fetchHashtagPosts({ token, hashtags = DEFAULT_HASHTAGS, limit = DEFAULT_LIMIT, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('brak tokenu Apify');
  const maxItems = hashtags.length * limit;
  const params = new URLSearchParams({
    timeout: '270',
    maxItems: String(maxItems),
    maxTotalChargeUsd: (maxItems * PRICE_USD * 1.2).toFixed(2), // twardy limit kosztu jednego uruchomienia
    format: 'json',
    clean: 'true',
  });
  const res = await fetchImpl(`https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?${params}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashtags, resultsType: 'posts', resultsLimit: limit }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Apify: HTTP ${res.status}`);
  const items = await res.json();
  return Array.isArray(items) ? items : [];
}
