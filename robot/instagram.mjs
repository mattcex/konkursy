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
const GIVEAWAY_RX = /rozdani|rozdaj|konkurs|giveaway|do wygrania|do zgarnięcia|wygraj|wygrać|nagrod/i;
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
// Nagłówek, pod którym są nagrody: „Do wygrania:”, „CO MOŻNA WYGRAĆ?”, „Nagrody:”, „…konkurs, w którym do zgarnięcia są:”
const PRIZE_HEADER_RX = /^(?:co\s+(?:można\s+)?(?:do\s+)?(?:wygra\S*|zgarn\S*)|do\s+(?:wygrania|zgarnięcia)|nagrod[ayęą]?(?:\s+główn\S*)?|(?:w\s+)?pul[ia]\s+nagród(?:\s+jest)?)\s*[:?!.\-–]*$|(?:do\s+(?:wygrania|zgarnięcia)|można\s+wygrać|nagrod[aąy])(?:\s+(?:są|jest|to))?\s*:\s*$/i;
const RULES_HEADER_RX = /^(?:jak|aby|żeby|co\s+(?:trzeba\s+)?zrobić|zasady|warunki|zadanie|regulamin)/i;
const B = '(?:^|[^a-ząćęłńóśźż])'; // początek słowa (np. „trafi”, ale nie „potrafi”)
// Zdania mówiące, co można wygrać…
const PRIZE_VERB_RX = new RegExp(
  [
    'do wygrania',
    'do zgarnięcia',
    `${B}zgarnij`,
    `${B}zgarnąć`,
    `${B}wygraj(?:cie)?\\s`,
    `${B}wygrać\\s`,
    '^nagrod\\S*\\s*(?:główn\\S*)?\\s*[:–-]',
    'nagrod\\S* (?:jest|są|to|stanowi)',
    'w nagrodę',
    '\\d+\\s+nagr',
    `${B}powędruj`,
    `${B}trafi(?:ą)?\\s`,
    `${B}otrzyma`,
    `${B}dla (?:jednej|\\d+) (?:osoby|osób|z was)`,
    'wygrywa\\S*\\s+(?!osob|najbardziej|najciekawsz|najlepsz|najzabawniejsz|komentarz|odpowied|autor|ta\\s|ten\\s|ci\\s)', // „opis wygrywa maszynkę”
    'przygotował\\S*[^.\\n]{0,30}(?:paczk|paczusz|zestaw|kalendarz|nagrod|prezent|upomin)',
    '\\d+\\s*[x×]\\s',
    '\\d+\\.?\\s*miejsc',
  ].join('|'),
  'i',
);
// …i konkretne nagrody
const PRIZE_NOUN_RX =
  /zestaw|kalendarz\S* adwentow|voucher|(?:^|[^a-ząćęłńóśźż])bon(?:y|u|ów)?(?![a-ząćęłńóśźż])|kart[aęy] podarunkow|egzemplarz|paczk|paczusz|książk|kosmetyk|perfum|aparat|słuchawk|konsol|ekspres|kub(?:ek|k)|projektor|bilet|karnet|pobyt|nocleg/i;
const PRIZE_ANY_RX = new RegExp(`${PRIZE_VERB_RX.source}|${PRIZE_NOUN_RX.source}`, 'i');
const prizeScore = (s) => (PRIZE_VERB_RX.test(s) ? 2 : 0) + (PRIZE_NOUN_RX.test(s) ? 1 : 0) + (/\d|zł/i.test(s) ? 0.5 : 0);
const RULES_RX = /obserwuj|oznacz|komentarz|polub|udostępnij|repost|zasad|warunk/i;
const RULE_START_RX = /^(?:\d+[.)]?\s*)?(?:w komentarzu\s+)?(?:obserwuj|zaobserwuj|oznacz|polub|udostępnij|zostaw|napisz|odpowiedz|zaproś|zapisz)/i;
const JUDGING_LINE_RX = /wygrywa\S*\s+(?:osoba|najbardziej|najciekawsz|najlepsz|komentarz|odpowied|autor|ta\s)/i;
// Zdania o wynikach, wysyłce i regulaminie – nie opisują nagrody
const META_LINE_RX = /wynik|ogłos|wysył|wyślę|wyślemy|organizator|regulamin|instagram|sponsor|zastrzeg|koszt|paczkomat|inpost|powodzenia|link w bio/i;
const GENERIC_RX = /rozdani\S*|konkurs\S*|giveaway|świąteczn\S*|mikołajkow\S*|urodzinow\S*|jesienn\S*|zimow\S*|wielk\S*|super|mega|czas na|na \d+\s*(?:tys|k)?/gi;
const POLISH_RX = /[ąęłńśźż]|rozdani|nagrod|wygra|zgarn/i;
// Zgłoszenie w komentarzu – tylko wtedy liczba komentarzy mówi o liczbie uczestników
const VIA_COMMENTS_RX = /komentarz|komentuj|pod (?:tym )?post|odpowied|napisz|oznacz/i;
// Nagrodę trzeba odebrać osobiście (np. w sklepie stacjonarnym)
const PICKUP_RX = /odbi(?:ór|oru)\s+osobist|odbierz\S*\s+(?:osobiście|w\s+(?:najbliższ\S+\s+)?(?:sklep|salon|lokal|restaurac|siedzib|punkc))|odbioru?\s+(?:nagrody\s+)?(?:wyłącznie\s+)?w\s+(?:sklep|salon|lokal)/i;
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
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200B}-\u{200D}\u{2060}\u{FEFF}\u{20E3}]/gu, '') // emoji i niewidoczne znaki
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
  // Zdanie przełamane po przecinku: „czekamy do 23:59,⏎1 grudnia 2026”
  const t = String(text || '').replace(/,[ \t]*\n/g, ', ');
  const re = new RegExp(
    // Rok tylko po kropce lub ukośniku – „18.11-01.12.2026” to zakres, a nie 18.11.2001
    `(\\d{1,2})\\s*[./-]\\s*(\\d{1,2})(?:\\s*[./]\\s*(\\d{4}|\\d{2}(?!\\d)))?(?![\\d:])|(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})(?:\\s+(\\d{4}))?`,
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

/** Zdania w linii (bez dzielenia po skrótach typu „ok.”, „godz.”, „ul.”). */
const sentences = (line) =>
  line
    .split(/(?<=[!?])\s+|(?<=\p{L}{4,}\.)\s+(?=\p{Lu})/u)
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Zdania o nagrodach: najpierw linie pod nagłówkiem „Do wygrania:”, potem zdania z „do zgarnięcia”,
 * „zestaw”, „otrzyma”, „powędruje”…, na końcu ogólne „wygraj” (bez zasad, wyników i wysyłki).
 */
export function prizeLines(text) {
  const raw = text.split('\n').map((l) => l.replace(/^[\s•*·\-–—>_]+/, '').replace(/#[^\s#]+/g, '').trim());
  const out = [];
  const header = raw.findIndex((l) => PRIZE_HEADER_RX.test(l));
  if (header >= 0) {
    for (const l of raw.slice(header + 1)) {
      if (out.length >= 3 || RULES_HEADER_RX.test(l) || PRIZE_HEADER_RX.test(l)) break;
      if (l && !META_LINE_RX.test(l)) out.push(sentences(l)[0]);
    }
  }
  if (!out.length) {
    const sents = raw.flatMap(sentences).filter((s) => s.length >= 4 && !META_LINE_RX.test(s) && !JUDGING_LINE_RX.test(s));
    // Najpierw zdania z czasownikiem i konkretną nagrodą („Do wygrania karta podarunkowa 300 zł”), potem pozostałe.
    const strong = sents
      .map((s, i) => ({ s, i, score: prizeScore(s) }))
      .filter((x) => x.score >= 1 && !RULE_START_RX.test(x.s) && !(RULES_RX.test(x.s) && x.score < 2))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.s);
    const weak = sents.filter((s) => /wygr[ay]/i.test(s) && !RULES_RX.test(s)); // „wygraj”, „wygrywa”, „wygrają”
    out.push(...strong, ...weak);
  }
  return [...new Set(out)].slice(0, 3).map((l) => cut(l, 200));
}

/** Krótki opis nagrody do tytułu: bez „Do wygrania:”, a z długiego zdania – fragment od nagrody. */
function prizeSubject(line) {
  let s = line
    .replace(/^.*?do (?:wygrania|zgarnięcia)(?:\s+(?:jest|są|mamy))?\s*:?\s*/i, '')
    .replace(/^(?:(?:rozdanie|konkurs|giveaway)\s*[:!.\-–—]*\s*)+/i, '')
    .replace(/^\d{1,2}[.)]\s+(?=\p{L})/u, '') // „1. Kalendarz adwentowy…”
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 90) {
    // Długie zdanie: zostaw ostatni człon (po przecinku lub myślniku), który wciąż mówi o nagrodzie.
    for (const m of [...s.matchAll(/,\s|\s[–-]\s/g)].reverse()) {
      const rest = s.slice(m.index + m[0].length);
      if (rest.length >= 25 && PRIZE_ANY_RX.test(rest)) {
        s = rest.replace(/^(?:w któr\S+|do któr\S+|dlatego|więc|a|i|oraz|ale)\s+/i, (x) => (/^do któr/i.test(x) ? x : ''));
        break;
      }
    }
  }
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

// Jeden zwycięzca, nawet gdy nagroda to zestaw wielu rzeczy („Zwycięzca zgarnie aż 36 produktów”)
const SINGLE_RX = /zwycięzca\s+(?:zgarnie|otrzyma|wygra|dostanie)|(?:dla\s+)?jedn(?:ej|a|ego)\s+(?:osob|z was|zwycięzc|szczęśliw)|do jednej z was/i;

const LW = '[a-ząćęłńóśźż]*';
const NUM = `(\\d{1,3}|jedn${LW}|dw${LW}|trz[yeo]${LW}|czter${LW}|pięć|pięci${LW}|sześć|sześci${LW}|siedem|siedmi${LW}|osiem|ośmi${LW}|dziewięć|dziewięci${LW}|dziesięć|dziesięci${LW})`;
const NUM_WORDS = [[/^jedn/, 1], [/^dw/, 2], [/^trz/, 3], [/^czter/, 4], [/^pięć|^pięci/, 5], [/^sześ/, 6], [/^siedem|^siedm/, 7], [/^osiem|^ośmi/, 8], [/^dziewię/, 9], [/^dziesię/, 10]];
// Liczba przed słowem, ale nie końcówka daty czy kwoty („30.11.2026 Zwycięzcę…”); tylko spacje, nie nowe linie.
const NUM_AT = `(?<![\\d.,:/])${NUM}`;
const WINNERS_RX = [
  new RegExp(`(?:wygrywa(?:ją)?|wybior(?:ę|ymy)|wybierzemy|wylosuj(?:ę|emy)|nagrodzimy)[ \\t]+(?:aż[ \\t]+)?${NUM_AT}[ \\t]+(?:osob|osób|zwycięzc|szczęśliw|najlepsz|najciekawsz|komentarz|odpowied)`, 'i'),
  new RegExp(`${B}${NUM_AT}[ \\t]+(?:szczęśliw${LW}[ \\t]+)?(?:osob${LW}|osób|zwycięzc${LW}|laureat${LW})[ \\t]+(?:otrzyma|wygra|zgarn|dostan)`, 'i'),
  new RegExp(`${B}${NUM_AT}[ \\t]+zwycięzc`, 'i'),
];

/** Liczba zwycięzców z opisu („wygrywają aż trzy osoby”, „Wybiorę 3 najciekawsze”, „4 zwycięzców”). */
export function winnersCount(text) {
  let best = 0;
  for (const rx of WINNERS_RX) {
    const m = String(text || '').match(rx);
    if (!m) continue;
    const w = m[1].toLowerCase();
    const n = /^\d+$/.test(w) ? +w : (NUM_WORDS.find(([r]) => r.test(w)) || [null, 0])[1];
    if (n > 0 && n <= 100) best = Math.max(best, n);
  }
  return best || null;
}

/**
 * Post z Instagrama → konkurs w formacie listy (albo null, gdy to nie jest trwające rozdanie po polsku).
 * Powód pominięcia trafia do `why.reason` (do statystyk w logach – bez treści postów).
 */
export function parsePost(p, today, why = {}) {
  const skip = (reason) => {
    why.reason = reason;
    return null;
  };
  if (!p || typeof p !== 'object' || p.error) return skip('błąd');
  const url = typeof p.url === 'string' ? p.url : '';
  const code = p.shortCode || igCode(url);
  if (!code || !/^https:\/\/(www\.)?instagram\.com\//.test(url)) return skip('adres');
  if (p.isCommentsDisabled === true) return skip('bez komentarzy');
  const text = cleanText(p.caption);
  if (text.length < 40) return skip('krótki opis');
  if (!POLISH_RX.test(text)) return skip('nie po polsku');
  if (!GIVEAWAY_RX.test(text) || !ENTRY_RX.test(text)) return skip('nie rozdanie');
  if (DONE_RX.test(text)) return skip('wyniki');

  const postISO = typeof p.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.timestamp) ? p.timestamp.slice(0, 10) : today;
  if (diffDays(postISO, today) > MAX_AGE_DAYS) return skip('stary post');
  let end = parseEndDate(text, postISO);
  const endGuess = !end;
  if (!end) {
    // Bez daty końca: dzień przed ogłoszeniem wyników, a gdy i tego brak – 7 dni od publikacji.
    const res = parseResultsDate(text, postISO);
    end = res && diffDays(postISO, res) >= 1 && diffDays(postISO, res) <= MAX_DAYS ? addDays(res, -1) : addDays(postISO, GUESS_DAYS);
  }
  if (diffDays(today, end) < 0) return skip('po terminie');

  const prizes = prizeLines(text);
  // Bez opisu nagrody: pierwsza linia, jeśli mówi coś więcej niż „ROZDANIE” i nie jest zasadą udziału.
  const firstLine = text.split('\n').map((l) => l.replace(/#[^\s#]+/g, '').trim()).find((l) => l.length >= 4) || '';
  const firstUseful = firstLine.length <= 90 && !RULES_RX.test(firstLine) && firstLine.replace(GENERIC_RX, '').replace(/[^\p{L}]/gu, '').length >= 8;
  const subject = prizes.length ? prizeSubject(prizes[0]) : firstUseful ? prizeSubject(firstLine) : 'nagroda na zdjęciu w poście';
  const kind = /konkurs/i.test(text) && !/rozdani|giveaway/i.test(text) ? 'Konkurs' : 'Rozdanie';
  const owner = typeof p.ownerUsername === 'string' && p.ownerUsername ? p.ownerUsername : '';
  const title = `${kind}${owner ? ` @${owner}` : ''}: ${cut(subject || firstLine, 90)}`;
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
  // Zgłoszenia przez stronę albo formularz („link w bio”): komentarze pod postem to nie uczestnicy.
  const comments = VIA_COMMENTS_RX.test(text) && typeof p.commentsCount === 'number' && p.commentsCount >= 0 ? Math.round(p.commentsCount) : null;
  const pickup = PICKUP_RX.test(text);
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
    // Liczba zwycięzców z opisu ma pierwszeństwo przed liczeniem „3x …” w nagrodach (to bywa zawartość jednego zestawu).
    prizeCount: winnersCount(task) || (SINGLE_RX.test(task) ? 1 : parsePrizeCount(prizesText) ?? 1),
    judging,
    location: pickup ? 'odbiór osobisty' : null,
    local: pickup,
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
 * Ponowne odczytanie zapisanego rozdania (tytuł, nagrody, liczba nagród, termin) z jego opisu –
 * poprawki rozpoznawania działają od razu także dla starszych wpisów, bez ponownego pobierania z Apify.
 */
export function reparse(c, today) {
  const fresh = parsePost(
    { shortCode: igCode(c.url), url: c.url, caption: c.task, commentsCount: c.comments, timestamp: c.start, ownerUsername: String(c.org || '').replace(/^@/, '') },
    today,
  );
  if (!fresh) return false; // np. już po terminie – zostaje jak jest
  for (const k of ['title', 'prizes', 'prizeCount', 'end', 'results', 'location', 'local']) c[k] = fresh[k];
  if (fresh.comments === null) {
    c.comments = null; // zgłoszenia nie w komentarzach – liczba komentarzy nic nie mówi o szansie
    c.commentsAt = null;
  }
  if (fresh.endGuess) c.endGuess = true;
  else delete c.endGuess;
  return true;
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
  const stats = { posts: (posts || []).length, found: 0, added: 0, updated: 0, skipped: {} };
  for (const p of posts || []) {
    const why = {};
    const c = parsePost(p, today, why);
    if (!c) {
      stats.skipped[why.reason] = (stats.skipped[why.reason] || 0) + 1;
      continue;
    }
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
