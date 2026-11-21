// Wspólna logika aplikacji Lootsy (przeglądarka) i robota (Node). Bez zależności.
import { translator } from './i18n.js';

export const TZ = 'Europe/Warsaw';
export const STATE_FILE = 'konkursy-state.json'; // nazwa pliku w giście (bez zmian, żeby nie zgubić danych)
export const DONE = new Set(['submitted', 'won', 'lost']);
export const STATUSES = ['', 'todo', 'submitted', 'won', 'lost', 'skipped'];

/** Zainteresowania (sekcja „Dla Ciebie”): nazwy w i18n „interest.*”. */
export const INTERESTS = ['mountains', 'ski', 'money', 'car', 'fujifilm', 'odds'];
export const GOOD_ODDS = 50; // „duża szansa”: 1 na 50 lub lepiej

export const DEFAULT_SETTINGS = {
  t: 0,
  lang: 'auto',
  hide: { party: true, fbShare: true, igShare: false, purchase: true, app: true, content: true, creative: true },
  // purchase: pasujące konkursy są widoczne mimo filtrów zakupu i aplikacji (loterie z autami i gotówką prawie zawsze ich wymagają)
  interests: { list: [...INTERESTS], purchase: true },
  ntfy: {
    enabled: true,
    server: 'https://ntfy.sh',
    topic: '',
    days: [1, 0],
    scope: 'all',
    maxOdds: 150,
    results: true,
    newStays: true,
    newValuable: true,
    newInterests: true,
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const isObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------- daty ----------

export const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

export function todayISO(date = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function diffDays(from, to) {
  return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400000);
}

/** Ile dni zostało do końca (0 = kończy się dziś, ujemne = zakończony). */
export function daysLeft(c, today) {
  return isISODate(c && c.end) ? diffDays(today, c.end) : null;
}

const MONTHS = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6,
  lipca: 7, sierpnia: 8, września: 9, października: 10, listopada: 11, grudnia: 12,
};

/** Szuka w opisie daty ogłoszenia wyników („Wyniki ogłosimy 24 grudnia”, „Zwycięzcę ogłosimy 16.11.2026”). */
export function parseResultsDate(text, refISO) {
  const t = String(text || '');
  const re = /(wynik|zwycięzc|laureat|ogłosimy|ogłoszeni)/gi;
  let m;
  while ((m = re.exec(t))) {
    const s = t.slice(m.index, m.index + 110);
    let d, mo, y = null;
    const a = s.match(/(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?/);
    const b = s.match(/(\d{1,2})\s+(stycznia|lutego|marca|kwietnia|maja|czerwca|lipca|sierpnia|września|października|listopada|grudnia)(?:\s+(\d{4}))?/i);
    if (b && (!a || b.index < a.index)) {
      d = +b[1]; mo = MONTHS[b[2].toLowerCase()]; y = b[3] ? +b[3] : null;
    } else if (a) {
      d = +a[1]; mo = +a[2]; y = a[3] ? +a[3] : null;
    } else continue;
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) continue;
    if (y !== null && y < 100) y += 2000;
    const ref = isISODate(refISO) ? refISO : todayISO();
    if (y === null) {
      y = +ref.slice(0, 4);
      if (mo < +ref.slice(5, 7) - 6) y += 1; // np. „5 stycznia” przy końcu w grudniu
    }
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

// ---------- klasyfikacja konkursów ----------

const RX = {
  stay: /pobyt|nocleg|\b\d+\s*noc(e|y|ami)?\b|hotel|apartament|domek letniskow|glamping|\bspa\b|resort|uzdrowisk|wycieczk|\brejs|wyjazd|wczas|urlop|bon\w* wakacyjn|weekend\w* (dla|w|nad)\b/i,
  party: /sylwest|\bbal(u|e|em|ach|ów)?\b|wejściów|dyskotek|koncert|festiwal|\bimprez|zaproszeni\w* na (bal|sylwest|imprez|koncert|festiwal|gal)|bilet\w* (wstępu )?na (bal|sylwest|imprez|zabaw|koncert|festiwal)/i,
  share: /udost[eę]pni|podziel się (tym |naszym )?(postem|wpisem)|\brepost|\brelacj|\bstor(y|ies)\b/i,
  optional: /opcjonaln|mile widzian|nie jest (to )?(warunk|wymagan|obowiązk)|nieobowiązk|będzie (mi|nam) (też |również )?(bardzo )?miło|jeśli (chcesz|macie|masz)|możesz (też|również)|dodatkow[a-ząćęłńóśźż]* szans|zwiększ[a-ząćęłńóśźż]* (swoje )?szans|nie musisz/i,
  fbHint: /facebook|\bfb\b|tablic|na swoim profilu/i,
  purchase: /\bkup(ić|uj|i|iłeś|iłaś|ując|ione)?\b|zakupu\b|zakupów za|zrób zakupy|dokonaj (zakupu|zakupów)|dowód zakupu|paragon|faktur|zarejestruj (swój )?(zakup|paragon)|przy zakupie|kupując/i,
  app: /aplikacj|\bw apce\b|\bapki\b|\bapka\b|\bapp\b/i,
  content: /(dodaj|załącz|wrzuć|prześlij|opublikuj|zrób|nagraj|stwórz|przygotuj|udostępnij|wstaw)[^.\n]{0,40}(zdjęci|fotk|fotograf|selfie|film|wideo|video|rolk|reels|grafik|rysun|kolaż|karuzel)|narysuj|namaluj|plastyczn|\bselfie\b|\brolk[aęi]\b|\breels\b/i,
  follow: /obserwuj|zaobserwuj|subskryb|polub (profil|stronę|fanpage|nasz profil|naszą stronę|nasz fanpage)/i,
  // Duży wysiłek: eseje, wiersze, opowiadania, nagrania, projekty, prace dyplomowe, konkursy szkolne, jazdy testowe
  creative:
    /esej|literack|literatur|opowiadani|\bwiersz|poezj|poety|tomik|scenariusz|koncepcj[aęi] serialu|\bscript\b|wokaln|piosenk|\butw[oó]r|\butwory|kompozycj|debiut|rękopis|maszynopis|przekład|tłumacz|olimpiad|dyplomow|prac[aey] konkursow|prac konkursow|arkuszy wydawniczych|reportaż|felieton|konkurs (graficzny|plastyczny|fotograficzny|literacki|poetycki|wokalny|muzyczny|filmowy)|aranżacj|projekt[a-ząćęłńóśźż]* (graficzn|architekton|logo|wnętrz)|\bstudia\b|uczniów|szkół|placówk|jazd[ęy] testow|nagrod[ay] im\./i,
  likes: /najwięcej (reakcji|polubień|lajków|serduszek)|największ[a-ząćęłńóśźż]* liczb[a-ząćęłńóśźż]* (reakcji|polubień|lajków)/i,
  draw: /losow|wylosuj|drodze losowania/i,
  jury: /jury|komisj|najciekawsz|najbardziej|najlepsz|najzabawniejsz|najoryginalniejsz|najtrafniejsz|kreatywn|wybierzemy|nagrodzimy|wyróżnim|autorzy \d+/i,
};

const WORD_NUM = { jedn: 1, osob: 1, znajom: 1, dw: 2, trz: 3, czter: 4, pięci: 5 };

function segments(text) {
  return String(text || '')
    .split(/\n|•|;|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tagCount(task) {
  const m = String(task || '').match(/(oznacz|zaproś)\w*[^.\n]{0,30}?(\d+|jedn\w*|dw[oóie]\w*|trz[yeo]\w*|czter\w*|pięci\w*|osob\w*|znajom\w*)/i);
  if (!m) return 0;
  if (/^\d+$/.test(m[2])) return Math.min(+m[2], 20);
  const w = m[2].toLowerCase();
  for (const [k, v] of Object.entries(WORD_NUM)) if (w.startsWith(k)) return v;
  return 1;
}

export function platformOf(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\.|^m\.|^web\./, '');
    if (/(^|\.)facebook\.com$|^fb\.(me|com|watch)$/.test(host)) return 'facebook';
    if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
    if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
    if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return 'youtube';
    if (/(^|\.)(x|twitter)\.com$/.test(host)) return 'x';
    return 'www';
  } catch {
    return 'www';
  }
}

/** Rozpoznaje rodzaj konkursu i wymagania na podstawie tytułu, zadania i nagród. */
export function classify({ title = '', task = '', prizes = '', platform = '', cats = [] } = {}) {
  const head = `${title}\n${prizes}`;
  const creativeCat = (cats || []).some((c) => /plastyczn|fotograficzn|literack|dla-uczniow/.test(c));
  const flags = {
    creative: creativeCat || RX.creative.test(`${title}\n${task}`),
    stay: RX.stay.test(head),
    party: RX.party.test(head),
    fbShare: false,
    igShare: false,
    shareOptional: false,
    purchase: RX.purchase.test(task),
    app: RX.app.test(task),
    content: RX.content.test(task),
    follow: RX.follow.test(task),
    tags: tagCount(task),
  };
  for (const seg of segments(task)) {
    if (!RX.share.test(seg)) continue;
    if (RX.optional.test(seg)) {
      flags.shareOptional = true;
      continue;
    }
    if (platform === 'instagram' && !/facebook/i.test(seg)) flags.igShare = true;
    else if (platform === 'facebook' || RX.fbHint.test(seg)) flags.fbShare = true;
    else flags.igShare = true;
  }
  const all = `${title}\n${task}\n${prizes}`;
  const judging = RX.likes.test(all) ? 'reakcje' : RX.draw.test(all) ? 'losowanie' : RX.jury.test(all) ? 'jury' : '?';
  return { flags, judging };
}

/** Liczba nagród z opisu („4x zestaw”, „2 i 3 miejsce”, „5 zestawów”, „I/II/III nagroda”). */
export function parsePrizeCount(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  let total = 0;
  for (const m of t.matchAll(/(?:^|[\s(:;,.–-])(\d{1,4})\s*[x×]\s/gi)) total += +m[1];
  if (total > 0) return total;
  const places = new Set();
  for (const m of t.matchAll(/(\d{1,3})\s*(?:-|–|i|do)\s*(\d{1,3})\s*\.?\s*miejsc/gi)) {
    const a = +m[1], b = +m[2];
    if (b >= a && b - a < 100) for (let i = a; i <= b; i++) places.add(i);
  }
  for (const m of t.matchAll(/(?:^|[^\d])(\d{1,3})\s*\.?\s*miejsc/gi)) places.add(+m[1]);
  const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
  for (const m of t.matchAll(/\b(I{1,3}|IV|V|VI{0,3}|IX|X)\s+(miejsce|nagroda|stopnia)/g)) places.add(ROMAN[m[1]]);
  if (places.size) return places.size;
  const m = t.match(/(\d{1,4})\s+(zestaw|nagr|laureat|zwycięzc|kart|bilet|voucher|bon[óy]|książ|box|paczk|egzemplarz|kalendarz|maskot|komplet|pakiet|podwójn|wejściów|zaprosze)/i);
  if (m) return +m[1];
  return 1;
}

// ---------- nagrody: rodzaj i wartość ----------

export const KIND_ORDER = ['trip', 'tech', 'voucher', 'other']; // nazwy sekcji: i18n „kind.*”
export const VALUABLE_FROM = 1000; // od tej wartości (zł) nagroda jest wyróżniana

const TECH_RX =
  /smartfon|iphone|\btelefon|galaxy|\bpixel\b|laptop|notebook|macbook|tablet|ipad|konsol|playstation|\bps5\b|xbox|nintendo|słuchawk|airpods|głośnik|soundbar|telewizor|\btv\b|monitor|aparat|kamer[aęy]|gopro|\bdron|hulajnog|\brower|smartwatch|zegarek|apple watch|airfryer|frytkownic|ekspres|odkurzacz|robot (sprząt|kuchen|planetarn|odkurz)|dyson|thermomix|obudow|zasilacz|chłodzeni|kart[aęy] graficzn|procesor|myszk|klawiatur|drukark|czytnik|kindle|projektor|płyt[aęy] indukcyjn|pralk|lodówk|zmywark|\bvr\b|router|dysk ssd|\bdysk\b|powerbank|sprzęt|elektronik|logitech|be quiet/i;
const VOUCHER_RX =
  /\bbon(y|ów|u|em|ami)?\b|voucher|kart[aęy] podarunkow|kart[aęy] (prezentow|upominkow|zakupow)|e-kart|e-bon|gotówk|nagrod[a-ząćęłńóśźż]* pieniężn|doładowani|zł na zakupy/i;
const AMOUNT_RX = /(\d{1,3}(?:[  .]\d{3})+|\d+)(?:,\d{1,2})?\s*(?:zł|pln|złotych)(?![a-ząćęłńóśźż])/gi;
// Przybliżone ceny, gdy w opisie nie ma kwoty (tylko sprzęt i wyjazdy).
const ESTIMATES = [
  [/macbook/i, 6000],
  [/thermomix/i, 6000],
  [/iphone/i, 5000],
  [/rejs|wycieczk|egipt|grecj|hiszpani|włoch|islandi|norwegi|laponi|all inclusive/i, 5000],
  [/laptop|notebook/i, 3500],
  [/telewizor|\btv\b/i, 2500],
  [/playstation|\bps5\b|xbox/i, 2500],
  [/ipad|tablet/i, 2000],
  [/smartfon|\btelefon|galaxy|\bpixel\b/i, 2000],
  [/dyson/i, 2000],
  [/aparat|kamer[aęy]|gopro|\bdron/i, 2000],
  [/nintendo/i, 1500],
  [/hulajnog|\brower/i, 1500],
  [/ekspres/i, 1500],
  [/odkurzacz|robot (sprząt|kuchen|planetarn|odkurz)/i, 1500],
  [/projektor/i, 1500],
  [/pobyt|nocleg|weekend|hotel|apartament|\bspa\b|wyjazd/i, 1200],
  [/smartwatch|apple watch|zegarek/i, 1000],
  [/monitor/i, 1000],
  [/słuchawk|airpods/i, 500],
  [/airfryer|frytkownic|głośnik/i, 400],
];

function parseAmount(s) {
  return Number(String(s).replace(/[  .]/g, ''));
}

/** Rodzaj nagrody (wyjazd / sprzęt / bon / inne) i wartość największej nagrody w zł. */
export function prizeInfo(c) {
  const prizes = String((c && c.prizes) || '');
  const text = prizes.trim() ? prizes : String((c && c.title) || '');
  const f = flagsOf(c);
  const kind = f.stay ? 'trip' : TECH_RX.test(text) ? 'tech' : VOUCHER_RX.test(text) ? 'voucher' : 'other';
  let value = null;
  for (const m of text.matchAll(AMOUNT_RX)) {
    const v = parseAmount(m[1]);
    if (Number.isFinite(v) && v > 0 && v < 1e7 && (value === null || v > value)) value = v;
  }
  let estimated = false;
  if (value === null && (kind === 'trip' || kind === 'tech')) {
    const hit = ESTIMATES.find(([rx]) => rx.test(text));
    if (hit) {
      value = hit[1];
      estimated = true;
    }
  }
  const tier = value === null ? null : value >= 3000 ? 'top' : value >= VALUABLE_FROM ? 'high' : value >= 300 ? 'mid' : 'low';
  return { kind, value: value === null ? null : Math.round(value), estimated, tier };
}

export const isValuable = (info) => info.tier === 'top' || info.tier === 'high';

// ---------- zainteresowania: „Dla Ciebie” ----------

// Początek słowa także przed polską literą (\b w JS zna tylko litery ASCII).
const W = '(?:^|[^a-ząćęłńóśźż0-9])';
const NOT_LETTER = '(?![a-ząćęłńóśźż])';
const MOUNTAIN_RX = new RegExp(
  `${W}(?:gór(?:y|ach|ami|ski|sk)|tatr|zakopan|giewont|kasprow|gubałówk|podhal|karkonosz|karpacz|szklarsk|świeradów|zieleni[eć]c|duszniki|polanic|sudet|bieszczad|arłam|beskid|szczyrk|korbielów|pienin|szczawnic|krynic[aęy][- ]zdr|jaworzyn|wierchoml|białk[aięą] tatrz|bukowin[aięą] tatrz|czarn[aąe]j? gór|alp(?:y|ach|ejsk)|dolomit)`,
  'i',
);
const SKI_RX = new RegExp(`${W}(?:nart|narciar|snowboard|skipass|ski ?pass|skitur|ski ?tour|stok(?:u|i|ach)? narciar|wyciąg[a-ząćęłńóśźż]* narciar)`, 'i');
const CAR_RX = new RegExp(
  `${W}(?:samoch[oó]d(?!ow)|auto(?:a|em)?${NOT_LETTER}|auta${NOT_LETTER}|toyot|škod|skod[aęy]${NOT_LETTER}|volvo|mini cooper|audi${NOT_LETTER}|bmw|mercedes|kia${NOT_LETTER}|hyundai|dacia|renault|peugeot|citro[eë]n|opel|volkswagen|cupra|tesla|mazd[aęy]${NOT_LETTER}|nissan|suzuki|bestune|changan|lexus|jeep)`,
  'i',
);
const CAR_NOT_RX = /\bf1\b|formuł|wyścig|\bteam\b|bilet|wejściów|ekspres|kaw[aęy]|grand theft|\bgta\b/i; // np. „wejściówka na wyścig Audi F1 Team”
const FUJI_RX = /fujifilm|fuji\b|instax/i;
const MONEY_WORD_RX = /gotów[kc]|pieniężn|pieniądz|pieniędz|przelew|czek[a-ząćęłńóśźż]* blik|na konto/i; // „gotówka”, „w gotówce”
const TAX_RX = /podat|dodatkow[a-ząćęłńóśźż]* nagrod[a-ząćęłńóśźż]* pieniężn/i; // dopłata na podatek to nie nagroda pieniężna
const NOT_MONEY_RX = /na gotówk|ekwiwalent/i; // „nie można wymienić na gotówkę”
const ATTACHED_MONEY_RX = /^(?:dodatkow[a-ząćęłńóśźż]*\s+)?(?:nagrod[a-ząćęłńóśźż]*|kwot[a-ząćęłńóśźż]*)\s+pieniężn/i;
const AMOUNT_ONLY_RX = new RegExp(`^\\d{1,3}(?:[  .]?\\d{3})*(?:,\\d{1,2})?\\s*(?:zł|pln|złotych)${NOT_LETTER}\\s*(?:brutto|netto|każd[aey]|$)`, 'i');

/** Fragmenty opisu nagród: osobne linie i punkty. */
const prizeParts = (text) =>
  String(text || '')
    .split(/[\n•;/]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Czy nagrodą są pieniądze (nie bon, karta podarunkowa, wartość rzeczy ani dopłata na podatek). */
export function hasMoneyPrize(prizes) {
  // W nawiasach są zwykle wartości rzeczy i dopłaty na podatek: „Suszarka (499 zł)”, „(oraz 6 667 zł na podatek)”.
  const text = String(prizes || '').replace(/\([^)]*\)?/g, ' ');
  for (const part of prizeParts(text)) {
    // Pierwszy człon to nagroda; „… oraz nagroda pieniężna” dopisana do rzeczy to dopłata na podatek.
    const subs = part.split(/\s(?:oraz|wraz z|plus|\+|i)\s/i);
    for (const [k, sub] of subs.entries()) {
      if (TAX_RX.test(sub) || NOT_MONEY_RX.test(sub)) continue;
      if (k > 0 && ATTACHED_MONEY_RX.test(sub)) continue;
      if (MONEY_WORD_RX.test(sub)) return true;
      if (/wartoś/i.test(sub)) continue; // „o wartości 600 zł”, „Łączna wartość nagród: 284,95 zł”
      // „2x 10 000 zł”, „Nagroda główna: 100 000 zł”, „tygodniowa: 13x 5000 zł”, „Nagroda główna 100 000 zł”
      const bare = sub
        .trim()
        .replace(/^[-–*]?\s*(?:\d+\s*[x×]\s*)?/i, '')
        .replace(/^[^:\d]{0,40}:\s*/, '')
        .replace(/^(?:nagrod[a-ząćęłńóśźż]*\s+)?(?:główn|tygodniow|dzienn|miesięczn|natychmiastow)[a-ząćęłńóśźż]*\s+/i, '')
        .replace(/^\d+\s*[x×]\s*/i, '');
      if (AMOUNT_ONLY_RX.test(bare)) return true;
    }
  }
  return false;
}

function hasCarPrize(text) {
  return prizeParts(text).some((part) => CAR_RX.test(part) && !CAR_NOT_RX.test(part));
}

/**
 * Zainteresowania, do których pasuje konkurs (podzbiór `wanted`, kolejność jak w INTERESTS).
 * Dopasowanie po tytule, nagrodach i miejscu – nie po treści zadania.
 */
export function interestsOf(c, it = {}, wanted = INTERESTS) {
  if (!c || !wanted || !wanted.length) return [];
  const want = new Set(wanted);
  const prizes = String(c.prizes || '');
  const hay = [c.title, prizes, c.location].filter(Boolean).join('\n');
  const f = flagsOf(c);
  const out = [];
  if (want.has('mountains') && (f.stay || /pobyt|nocleg|weekend|wyjazd|wycieczk|wakacj|hotel|urlop|ferie/i.test(hay)) && MOUNTAIN_RX.test(hay)) out.push('mountains');
  if (want.has('ski') && SKI_RX.test(hay)) out.push('ski');
  if (want.has('money') && hasMoneyPrize(prizes || c.title)) out.push('money');
  if (want.has('car') && hasCarPrize(hay)) out.push('car');
  if (want.has('fujifilm') && FUJI_RX.test(hay)) out.push('fujifilm');
  if (want.has('odds')) {
    const odds = oddsOf(c, it);
    if (odds !== null && odds <= GOOD_ODDS) out.push('odds');
  }
  return out;
}

/** Powód ukrycia z uwzględnieniem „Dla Ciebie”: pasujące konkursy omijają filtry zakupu i aplikacji. */
export function hiddenFor(c, settings, interests) {
  const s = settings || DEFAULT_SETTINGS;
  const reason = hiddenReason(c, s.hide);
  if (!reason || !interests || !interests.length || !s.interests || !s.interests.purchase) return reason;
  if (reason !== 'purchase' && reason !== 'app') return reason;
  // Po ominięciu jednego filtra może zadziałać kolejny (np. zakup + udostępnienie na FB).
  return hiddenReason(c, { ...s.hide, purchase: false, app: false });
}

export function formatPLN(v, lang = 'pl') {
  return translator(lang).money(v);
}

// ---------- stan użytkownika ----------

export function emptyState() {
  return { v: 1, items: {}, manual: {}, settings: clone(DEFAULT_SETTINGS) };
}

export function settingsOf(state) {
  const s = isObj(state && state.settings) ? state.settings : {};
  const out = clone(DEFAULT_SETTINGS);
  out.t = num(s.t) || 0;
  if (s.lang === 'auto' || s.lang === 'pl' || s.lang === 'en') out.lang = s.lang;
  if (isObj(s.hide)) for (const k of Object.keys(out.hide)) if (typeof s.hide[k] === 'boolean') out.hide[k] = s.hide[k];
  if (isObj(s.interests)) {
    if (Array.isArray(s.interests.list)) out.interests.list = INTERESTS.filter((id) => s.interests.list.includes(id));
    if (typeof s.interests.purchase === 'boolean') out.interests.purchase = s.interests.purchase;
  }
  if (isObj(s.ntfy)) {
    const n = s.ntfy;
    if (typeof n.enabled === 'boolean') out.ntfy.enabled = n.enabled;
    if (typeof n.server === 'string' && /^https?:\/\//.test(n.server)) out.ntfy.server = n.server.trim();
    if (typeof n.topic === 'string') out.ntfy.topic = n.topic.trim().slice(0, 64);
    if (Array.isArray(n.days)) out.ntfy.days = n.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 14);
    if (n.scope === 'all' || n.scope === 'todo') out.ntfy.scope = n.scope;
    if (num(n.maxOdds) && n.maxOdds > 0) out.ntfy.maxOdds = n.maxOdds;
    if (typeof n.results === 'boolean') out.ntfy.results = n.results;
    if (typeof n.newStays === 'boolean') out.ntfy.newStays = n.newStays;
    if (typeof n.newValuable === 'boolean') out.ntfy.newValuable = n.newValuable;
    if (typeof n.newInterests === 'boolean') out.ntfy.newInterests = n.newInterests;
  }
  return out;
}

const STATUS_SET = new Set(STATUSES);

function cleanItem(it) {
  if (!isObj(it)) return null;
  const out = { t: num(it.t) || 0 };
  if (typeof it.s === 'string' && STATUS_SET.has(it.s)) out.s = it.s;
  if (isISODate(it.at)) out.at = it.at;
  if (isISODate(it.results)) out.results = it.results;
  if (num(it.comments) !== null && it.comments >= 0) out.comments = Math.round(it.comments);
  if (isISODate(it.commentsAt)) out.commentsAt = it.commentsAt;
  if (num(it.prizes) !== null && it.prizes > 0) out.prizes = Math.round(it.prizes);
  if (typeof it.note === 'string') out.note = it.note.slice(0, 5000);
  if (typeof it.answer === 'string') out.answer = it.answer.slice(0, 5000);
  if (isObj(it.snap)) {
    const s = it.snap;
    out.snap = {};
    for (const k of ['title', 'url', 'end', 'prizes', 'org', 'src']) if (typeof s[k] === 'string') out.snap[k] = s[k].slice(0, 2000);
  }
  return out;
}

export function cleanContest(c) {
  if (!isObj(c) || typeof c.id !== 'string') return null;
  const out = { id: c.id.slice(0, 200), t: num(c.t) || 0 };
  for (const k of ['title', 'org', 'url', 'src', 'platform', 'task', 'prizes', 'location', 'judging', 'note']) {
    if (typeof c[k] === 'string') out[k] = c[k].slice(0, 5000);
  }
  for (const k of ['start', 'end', 'results', 'firstSeen', 'commentsAt']) if (isISODate(c[k])) out[k] = c[k];
  for (const k of ['comments', 'prizeCount']) if (num(c[k]) !== null && c[k] >= 0) out[k] = Math.round(c[k]);
  if (isObj(c.flags)) out.flags = { ...c.flags };
  if (Array.isArray(c.answers)) out.answers = c.answers.filter((a) => typeof a === 'string').slice(0, 10);
  if (c.deleted === true) out.deleted = true;
  out.manual = true;
  return out;
}

/** Sprawdza i porządkuje stan wczytany z pliku, gista lub localStorage. */
export function normalizeState(raw) {
  const st = emptyState();
  if (!isObj(raw)) return st;
  if (isObj(raw.items)) {
    for (const [id, it] of Object.entries(raw.items)) {
      const c = cleanItem(it);
      if (c) st.items[id] = c;
    }
  }
  if (isObj(raw.manual)) {
    for (const [id, c] of Object.entries(raw.manual)) {
      const m = cleanContest({ ...c, id });
      if (m) st.manual[id] = m;
    }
  }
  st.settings = settingsOf(raw);
  return st;
}

/** Łączy dwa stany: dla każdego konkursu wygrywa nowsza zmiana (pole t). */
export function mergeStates(a, b) {
  const x = normalizeState(a);
  const y = normalizeState(b);
  const out = emptyState();
  for (const key of ['items', 'manual']) {
    for (const id of new Set([...Object.keys(x[key]), ...Object.keys(y[key])])) {
      const p = x[key][id];
      const q = y[key][id];
      out[key][id] = !p ? q : !q ? p : (q.t || 0) > (p.t || 0) ? q : p;
    }
  }
  const [win, lose] = (y.settings.t || 0) > (x.settings.t || 0) ? [y.settings, x.settings] : [x.settings, y.settings];
  out.settings = clone(win);
  // Nie gub kanału ntfy, gdy nowsze ustawienia pochodzą z urządzenia, które go jeszcze nie znało.
  if (!out.settings.ntfy.topic && lose.ntfy.topic) out.settings.ntfy.topic = lose.ntfy.topic;
  return out;
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObj(v)) return v;
  const o = {};
  for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]);
  return o;
}

export const stateKey = (s) => JSON.stringify(sortKeys(normalizeState(s)));
export const sameState = (a, b) => stateKey(a) === stateKey(b);

// ---------- widok konkursów ----------

export const itemOf = (state, id) => (state && state.items && state.items[id]) || {};

/** Konkursy z katalogu + dodane ręcznie + zapamiętane zgłoszenia, których nie ma już w katalogu. */
export function allContests(catalog, state) {
  const list = [];
  const seen = new Set();
  for (const c of (catalog && catalog.contests) || []) {
    if (!c || typeof c.id !== 'string' || seen.has(c.id)) continue;
    seen.add(c.id);
    list.push(c);
  }
  for (const m of Object.values((state && state.manual) || {})) {
    if (!m || m.deleted || seen.has(m.id)) continue;
    seen.add(m.id);
    list.push(m);
  }
  for (const [id, it] of Object.entries((state && state.items) || {})) {
    if (seen.has(id) || !it.snap || !it.snap.title) continue;
    seen.add(id);
    list.push({ id, ...it.snap, gone: true });
  }
  return list;
}

export function flagsOf(c) {
  return { stay: false, party: false, fbShare: false, igShare: false, purchase: false, app: false, content: false, creative: false, follow: false, tags: 0, ...((c && c.flags) || {}) };
}

/** Powód ukrycia konkursu według filtrów użytkownika: kod („party”, „fbShare”…; i18n „reason.*”) albo '' = widoczny. */
export function hiddenReason(c, hide) {
  const f = flagsOf(c);
  const h = hide || DEFAULT_SETTINGS.hide;
  if (h.party && f.party) return 'party';
  if (h.fbShare && f.fbShare) return 'fbShare';
  if (h.igShare && f.igShare) return 'igShare';
  if (h.purchase && f.purchase) return 'purchase';
  if (h.app && f.app) return 'app';
  if (h.content && f.content && !f.stay) return 'content';
  if (h.creative && f.creative) return 'creative';
  return '';
}

/** Nowsza z dwóch liczb komentarzy: z katalogu albo wpisana ręcznie. */
export function commentsOf(c, it = {}) {
  const a = num(c && c.comments) !== null ? { n: c.comments, at: c.commentsAt || '' } : null;
  const b = num(it.comments) !== null ? { n: it.comments, at: it.commentsAt || '' } : null;
  if (a && b) return b.at >= a.at ? b : a;
  return b || a;
}

export function prizesOf(c, it = {}) {
  if (num(it.prizes) && it.prizes > 0) return it.prizes;
  if (num(c && c.prizeCount) && c.prizeCount > 0) return c.prizeCount;
  return null;
}

/** Szansa jako „1 na N” (N = komentarze / nagrody). */
export function oddsOf(c, it = {}) {
  const cm = commentsOf(c, it);
  const p = prizesOf(c, it);
  if (!cm || !p) return null;
  return Math.max(1, Math.round(cm.n / p));
}

export const resultsOf = (c, it = {}) => (isISODate(it.results) ? it.results : isISODate(c && c.results) ? c.results : null);

// ---------- powiadomienia ----------

export function pickNotifications(contests, state, today) {
  const s = settingsOf(state);
  const n = s.ntfy;
  const out = { ending: [], results: [], newInterests: [], newStays: [], newValuable: [] };
  for (const c of contests) {
    const it = itemOf(state, c.id);
    const st = it.s || '';
    const dl = daysLeft(c, today);
    const interests = interestsOf(c, it, s.interests.list);
    const hidden = hiddenFor(c, s, interests);
    const odds = oddsOf(c, it);
    if (dl !== null && dl >= 0 && !DONE.has(st) && st !== 'skipped' && n.days.includes(dl)) {
      const ok = st === 'todo' || (n.scope === 'all' && !hidden && (odds === null || odds <= n.maxOdds));
      if (ok) out.ending.push({ c, dl, odds, todo: st === 'todo' });
    }
    if (n.results && st === 'submitted') {
      const rd = resultsOf(c, it) || (isISODate(c.end) ? addDays(c.end, 3) : null);
      if (rd === today) out.results.push({ c });
    }
    if (c.firstSeen === today && !hidden && st !== 'skipped' && (dl === null || dl >= 0)) {
      const info = prizeInfo(c);
      if (n.newInterests && interests.length) out.newInterests.push({ c, odds, info, interests });
      else if (n.newStays && flagsOf(c).stay) out.newStays.push({ c, odds, info });
      else if (n.newValuable && isValuable(info)) out.newValuable.push({ c, odds, info });
    }
  }
  out.ending.sort((a, b) => a.dl - b.dl || Number(b.todo) - Number(a.todo) || (a.odds ?? 1e9) - (b.odds ?? 1e9));
  out.ending = out.ending.slice(0, 10);
  out.newInterests.sort((a, b) => (b.info.value || 0) - (a.info.value || 0));
  out.newInterests = out.newInterests.slice(0, 10);
  out.newStays = out.newStays.slice(0, 10);
  out.newValuable.sort((a, b) => (b.info.value || 0) - (a.info.value || 0));
  out.newValuable = out.newValuable.slice(0, 10);
  return out;
}

const short = (s, n = 70) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

export function plural(n, [one, few, many]) {
  if (n === 1) return one;
  const d = n % 10;
  const dd = n % 100;
  return d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14) ? few : many;
}

/** Jedna zbiorcza wiadomość ntfy (albo null, gdy nie ma o czym przypominać). */
export function buildDigest(p, { appUrl = '', lang = 'pl' } = {}) {
  const { t, tn, money } = translator(lang);
  const odds = (n) => (n ? t('digest.odds', { n }) : '');
  const lines = [];
  const tags = [];
  let priority = 3;
  for (const e of p.ending) {
    const when = e.dl === 0 ? t('digest.today') : e.dl === 1 ? t('digest.tomorrow') : t('digest.inDays', { n: e.dl });
    lines.push(`⏰ ${when}: ${short(e.c.title)}${odds(e.odds)}${e.todo ? ' ★' : ''}`);
    if (e.dl === 0) priority = 4;
  }
  if (p.ending.length) tags.push('alarm_clock');
  const newInterests = p.newInterests || [];
  for (const e of newInterests) {
    const v = e.info && e.info.value ? ` – ${e.info.estimated ? '~' : ''}${money(e.info.value)}` : '';
    const i = e.interests.map((id) => t(`interest.${id}`)).join(', ');
    lines.push(t('digest.newInterest', { i, v, t: short(e.c.title) }) + odds(e.odds));
  }
  if (newInterests.length) tags.push('dart');
  for (const e of p.newStays) lines.push(t('digest.newStay', { t: short(e.c.title) }) + odds(e.odds));
  if (p.newStays.length) tags.push('hotel');
  const newValuable = p.newValuable || [];
  for (const e of newValuable) {
    const v = e.info && e.info.value ? ` – ${e.info.estimated ? '~' : ''}${money(e.info.value)}` : '';
    lines.push(t('digest.newValuable', { v, t: short(e.c.title) }) + odds(e.odds));
  }
  if (newValuable.length) tags.push('gem');
  for (const e of p.results) lines.push(t('digest.results', { t: short(e.c.title) }));
  if (p.results.length) tags.push('trophy');
  if (!lines.length) return null;
  const parts = [];
  if (p.ending.length) parts.push(tn('digest.ending', p.ending.length));
  if (newInterests.length) parts.push(tn('digest.forYou', newInterests.length));
  if (p.newStays.length) parts.push(tn('digest.stays', p.newStays.length));
  if (newValuable.length) parts.push(tn('digest.valuable', newValuable.length));
  if (p.results.length) parts.push(t('digest.resultsCount', { n: p.results.length }));
  const msg = { title: t('digest.title', { parts: parts.join(', ') }), message: lines.join('\n'), priority, tags };
  if (appUrl) msg.click = appUrl;
  return msg;
}

// ---------- odświeżanie: robot uruchamiany z aplikacji ----------

export const ROBOT_WORKFLOW = 'robot.yml';

/** Uruchomienie robota zlecone z aplikacji – rozpoznawane po identyfikatorze w nazwie (run-name). */
export function findDispatchedRun(runs, requestId) {
  if (!requestId) return null;
  return (runs || []).find((r) => r && typeof r.display_title === 'string' && r.display_title.includes(requestId)) || null;
}

/** Link do formularza tokenu GitHub z zaznaczonymi uprawnieniami: gisty (synchronizacja) i Actions (odświeżanie). */
export function tokenTemplateUrl() {
  const p = new URLSearchParams({
    name: 'Lootsy',
    description: 'Lootsy: synchronizacja (gist) i odświeżanie listy (Actions)',
    expires_in: '366',
    gists: 'write',
    actions: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${p}`;
}

export function randomTopic() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(14);
  globalThis.crypto.getRandomValues(bytes);
  return 'konkursy-' + Array.from(bytes, (b) => abc[b % abc.length]).join('');
}
