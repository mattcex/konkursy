import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePost, parseEndDate, mergeInstagram, fetchHashtagPosts, igCode, cleanText } from '../robot/instagram.mjs';

const today = '2026-11-21';
const post = (caption, extra = {}) => ({
  shortCode: 'DAbc123xyz',
  url: 'https://www.instagram.com/p/DAbc123xyz/',
  caption,
  commentsCount: 14,
  timestamp: '2026-11-21T08:30:00.000Z',
  ownerUsername: 'kosmetyki_anny',
  ...extra,
});

const GIVEAWAY = [
  '🎁 ROZDANIE 🎁',
  'Do wygrania zestaw kosmetyków naturalnych o wartości 300 zł!',
  'Zasady:',
  '1. Obserwuj @kosmetyki_anny',
  '2. Polub ten post',
  '3. W komentarzu oznacz 2 osoby',
  'Rozdanie trwa do 28.11 do godz. 23:59. Wyniki ogłosimy 30.11 w relacji.',
  '#rozdanie #konkurs #kosmetyki',
].join('\n');

test('instagram: post z rozdaniem → konkurs', () => {
  const c = parsePost(post(GIVEAWAY), today);
  assert.equal(c.id, 'ig:DAbc123xyz');
  assert.equal(c.origin, 'ig');
  assert.equal(c.platform, 'instagram');
  assert.equal(c.title, 'Rozdanie @kosmetyki_anny: zestaw kosmetyków naturalnych o wartości 300 zł!');
  assert.equal(c.org, '@kosmetyki_anny');
  assert.equal(c.start, '2026-11-21');
  assert.equal(c.end, '2026-11-28'); // nie data wyników (30.11)
  assert.equal(c.results, '2026-11-30');
  assert.equal(c.endGuess, undefined);
  assert.equal(c.comments, 14);
  assert.equal(c.commentsAt, today);
  assert.equal(c.prizeCount, 1);
  assert.match(c.prizes, /zestaw kosmetyków/);
  assert.doesNotMatch(c.task, /#kosmetyki/); // linia z samymi hashtagami usunięta
  assert.equal(c.flags.follow, true);
  assert.equal(c.flags.tags, 2);
  assert.equal(c.flags.purchase, false);
});

test('instagram: pomija wyniki, zakończone, obce języki i stare posty', () => {
  assert.equal(parsePost(post('Wyniki rozdania! Zestaw kosmetyków wygrywa: @ola_k. Gratulacje @ola_k, napisz do nas na priv! #rozdanie'), today), null);
  assert.equal(parsePost(post('Rozdanie zostało zakończone, dziękujemy za udział i wszystkie komentarze! #rozdanie #konkurs'), today), null);
  assert.equal(parsePost(post('Giveaway time! Win a skincare set – follow us and comment below with your favourite product. #giveaway'), today), null);
  assert.equal(parsePost(post(GIVEAWAY, { timestamp: '2026-10-01T10:00:00Z' }), today), null);
  assert.equal(parsePost(post(GIVEAWAY, { isCommentsDisabled: true }), today), null);
  assert.equal(parsePost({ ...post(GIVEAWAY), url: 'https://example.com/p/x' }, today), null);
});

test('instagram: bez daty końca → 7 dni od publikacji', () => {
  const c = parsePost(post('KONKURS 🎄 Wygraj voucher 200 zł do naszej kawiarni! Napisz w komentarzu, z kim przyjdziesz na kawę ☕ #konkurs'), today);
  assert.equal(c.end, '2026-11-28');
  assert.equal(c.endGuess, true);
  assert.equal(c.title, 'Konkurs @kosmetyki_anny: Wygraj voucher 200 zł do naszej kawiarni!'); // bez powtórzonego „KONKURS”
});

test('instagram: daty końca', () => {
  assert.equal(parseEndDate('Konkurs trwa od 20.11 do 27.11.', '2026-11-20'), '2026-11-27');
  assert.equal(parseEndDate('Na zgłoszenia czekamy do 5 grudnia 2026', today), '2026-12-05');
  assert.equal(parseEndDate('Rozdanie trwa do 3.01, nagrody wyślemy do 15.01', '2026-12-20'), '2027-01-03');
  assert.equal(parseEndDate('Rozdanie z nagrodą trwa do 30.11', today), '2026-11-30');
  assert.equal(parseEndDate('Trwa do 23.59 w niedzielę', today), null); // godzina, nie data
  assert.equal(parseEndDate('Wyniki ogłosimy 2.12', today), null);
  assert.equal(parseEndDate('trwa do 31.11', today), null); // nie ma takiego dnia
});

test('instagram: kod posta, czyszczenie tekstu', () => {
  assert.equal(igCode('https://www.instagram.com/reel/C1x-Y_z/?igsh=abc'), 'C1x-Y_z');
  assert.equal(igCode('https://www.instagram.com/kosmetyki/p/DAbc/'), 'DAbc');
  assert.equal(igCode('https://www.facebook.com/p/1'), null);
  assert.equal(cleanText('𝗥𝗢𝗭𝗗𝗔𝗡𝗜𝗘 🎁 dla Was'), 'ROZDANIE dla Was');
});

test('instagram: łączenie z listą bez duplikatów', () => {
  const ek = { id: 'ek:x', url: 'https://www.instagram.com/p/DAbc123xyz/', comments: 3, commentsAt: '2026-11-19', origin: undefined };
  const byId = new Map([[ek.id, ek]]);
  const r = mergeInstagram(byId, [post(GIVEAWAY), post(GIVEAWAY, { shortCode: 'DNew1', url: 'https://www.instagram.com/p/DNew1/' }), { error: 'not_found' }], today);
  assert.deepEqual(r, { posts: 3, found: 2, added: 1, updated: 1, skipped: { błąd: 1 } });
  assert.equal(ek.comments, 14); // ten sam post z e-konkursy: tylko świeża liczba komentarzy
  assert.equal(ek.commentsAt, today);
  assert.ok(byId.has('ig:DNew1'));
  assert.equal('endGuess' in byId.get('ig:DNew1'), false);
});

test('instagram: zapytanie do Apify z tokenem w nagłówku i limitem kosztu', async () => {
  let call;
  const fetchImpl = async (url, opts) => {
    call = { url, opts };
    return { ok: true, json: async () => [post(GIVEAWAY)] };
  };
  const items = await fetchHashtagPosts({ token: 'apify_api_TEST', hashtags: ['rozdanie', 'konkurs'], limit: 25, fetchImpl });
  assert.equal(items.length, 1);
  assert.match(call.url, /^https:\/\/api\.apify\.com\/v2\/acts\/apify~instagram-hashtag-scraper\/run-sync-get-dataset-items\?/);
  assert.doesNotMatch(call.url, /apify_api_TEST/); // token nie trafia do adresu (ani do logów)
  assert.equal(call.opts.headers.Authorization, 'Bearer apify_api_TEST');
  const params = new URL(call.url).searchParams;
  assert.equal(params.get('maxItems'), '50');
  assert.equal(params.get('maxTotalChargeUsd'), '0.16');
  assert.deepEqual(JSON.parse(call.opts.body), { hashtags: ['rozdanie', 'konkurs'], resultsType: 'posts', resultsLimit: 25 });
  await assert.rejects(fetchHashtagPosts({ token: 'x', fetchImpl: async () => ({ ok: false, status: 402 }) }), /HTTP 402/);
});
