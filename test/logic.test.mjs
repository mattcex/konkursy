import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../site/logic.js';

test('daty: różnica dni, dodawanie, dzisiejsza data w strefie Warszawy', () => {
  assert.equal(L.diffDays('2026-11-20', '2026-11-26'), 6);
  assert.equal(L.diffDays('2026-03-28', '2026-03-30'), 2); // zmiana czasu
  assert.equal(L.addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(L.todayISO(new Date('2026-11-20T23:30:00Z')), '2026-11-21');
  assert.equal(L.daysLeft({ end: '2026-11-20' }, '2026-11-20'), 0);
  assert.equal(L.daysLeft({ end: '2026-11-19' }, '2026-11-20'), -1);
  assert.equal(L.daysLeft({}, '2026-11-20'), null);
});

test('data wyników z opisu', () => {
  assert.equal(L.parseResultsDate('Wyniki ogłosimy 24 grudnia 2026 r., w Wigilię!', '2026-12-20'), '2026-12-24');
  assert.equal(L.parseResultsDate('Zwycięzcę ogłosimy 16.11.2026r na profilu', '2026-11-15'), '2026-11-16');
  assert.equal(L.parseResultsDate('Wyniki zostaną ogłoszone 23 listopada.', '2026-11-19'), '2026-11-23');
  assert.equal(L.parseResultsDate('Wyniki ogłosimy 5 stycznia', '2026-12-20'), '2027-01-05');
  assert.equal(L.parseResultsDate('Wynik zostanie ogłoszony do 7 dni roboczych', '2026-11-15'), null);
  assert.equal(L.parseResultsDate('Napisz komentarz', '2026-11-15'), null);
});

test('liczba nagród', () => {
  assert.equal(L.parsePrizeCount('4x zestaw zabawek, przydzielony przez jury'), 4);
  assert.equal(L.parsePrizeCount('1x wycieczka dla jednej osoby\n2x 1000 zł voucher\n3x 500 zł voucher'), 6);
  assert.equal(L.parsePrizeCount('20x duża maskotka + bon 700 zł\n100x mała maskotka + bon 200 zł'), 120);
  assert.equal(L.parsePrizeCount('1 miejsce: Pobyt dla 2 osób\n2 i 3 miejsce: Zestaw\n4 i 5 miejsce: Mydło'), 5);
  assert.equal(L.parsePrizeCount('I nagroda: karta 1500 zł\nII nagroda: karta 1000 zł\nIII nagroda: karta 500 zł'), 3);
  assert.equal(L.parsePrizeCount('5 zestawów po 12 dżemów Stovit!'), 5);
  assert.equal(L.parsePrizeCount('3 laureatów otrzyma po jednej karcie podarunkowej'), 3);
  assert.equal(L.parsePrizeCount('1x chłodzenie 360mm 3x120mm\n1x obudowa\n1x zasilacz'), 3);
  assert.equal(L.parsePrizeCount('Kalendarz adwentowy'), 1);
  assert.equal(L.parsePrizeCount(''), null);
});

test('klasyfikacja: impreza + wymagane udostępnienie na FB', () => {
  const { flags } = L.classify({
    title: 'Wygraj bilet na Sylwestra Krzeszowice',
    task: 'Polub post\nUdostępnij go publicznie na swoim profilu\nW komentarzu oznacz osobę, z którą chcesz spędzić Sylwestra',
    prizes: '1 bilet wstępu na zabawę sylwestrową',
    platform: 'facebook',
  });
  assert.equal(flags.party, true);
  assert.equal(flags.fbShare, true);
  assert.equal(flags.stay, false);
  assert.equal(flags.tags, 1);
});

test('klasyfikacja: udostępnienie nieobowiązkowe nie ukrywa konkursu', () => {
  const { flags } = L.classify({
    title: 'Mikołajkowy konkurs – wygraj mini box ze świecami sojowymi',
    task: 'Polub post konkursowy\nZaproś w komentarzu 3 koleżanki.\nBędzie mi też bardzo miło, jeśli udostępnisz ten post na swojej tablicy',
    prizes: '2 boxy ze świecami',
    platform: 'facebook',
  });
  assert.equal(flags.fbShare, false);
  assert.equal(flags.shareOptional, true);
  assert.equal(flags.tags, 3);
  assert.equal(L.hiddenReason({ flags }, L.DEFAULT_SETTINGS.hide), '');
});

test('klasyfikacja: Instagram, zakup, aplikacja, zdjęcie, nocleg, jury', () => {
  assert.equal(L.classify({ task: 'Polub i udostępnij post konkursowy oraz oznacz 2 osoby.', platform: 'instagram' }).flags.igShare, true);
  assert.equal(L.classify({ task: 'Kup zgrzewkę wody i opisz historię' }).flags.purchase, true);
  assert.equal(L.classify({ task: 'Robicie listę zakupów do M Park – co kupicie na literę M?' }).flags.purchase, false);
  assert.equal(L.classify({ task: 'Kliknij w apce „Dołącz do misji”' }).flags.app, true);
  const trip = L.classify({
    title: 'Dokąd zaprowadziła mnie ciekawość',
    task: 'W komentarzu pod postem dodaj własne zdjęcie z wyjazdu i krótką historię',
    prizes: '1x wycieczka (Islandia)',
  });
  assert.equal(trip.flags.content, true);
  assert.equal(trip.flags.stay, true);
  assert.equal(L.hiddenReason(trip, L.DEFAULT_SETTINGS.hide), ''); // wyjazdy zostają mimo zdjęcia
  assert.equal(L.classify({ prizes: 'Pobyt dla 2 osób w Hotelu Pod Różą' }).flags.stay, true);
  assert.equal(L.classify({ prizes: 'I nagroda: karta 1500 zł. Karty możecie wykorzystać na pobyt w Innym Świecie' }).flags.stay, true);
  assert.equal(L.classify({ prizes: 'Balsam do ciała i krem' }).flags.party, false);
  assert.equal(L.classify({ task: 'Autorzy 120 najciekawszych odpowiedzi w ocenie jury wygrają' }).judging, 'jury');
  assert.equal(L.classify({ task: 'Zwycięzców wyłonimy w drodze losowania' }).judging, 'losowanie');
  assert.equal(L.classify({ task: 'wygrywają trzy komentarze z największą liczbą reakcji' }).judging, 'reakcje');
});

test('klasyfikacja: praca twórcza (duży wysiłek) jest domyślnie ukryta', () => {
  const hide = L.DEFAULT_SETTINGS.hide;
  const essay = L.classify({ title: 'VI edycja Konkursu na esej filozoficzny', task: 'Napisz esej na temat demokracji' });
  assert.equal(essay.flags.creative, true);
  assert.equal(L.hiddenReason(essay, hide), 'praca twórcza');
  assert.equal(L.classify({ task: 'Napisz opowiadanie kryminalne osadzone w Poznaniu' }).flags.creative, true);
  assert.equal(L.classify({ task: 'Każdy uczestnik może zgłosić maksymalnie 3 wiersze.' }).flags.creative, true);
  assert.equal(L.classify({ task: 'Umów się i odbądź jazdę testową u dealera' }).flags.creative, true);
  assert.equal(L.classify({ title: 'Konkurs', task: 'Opis', cats: ['konkursy-plastyczne'] }).flags.creative, true);
  // zwykły konkurs z komentarzem zostaje widoczny
  const comment = L.classify({ task: 'W komentarzu napisz, jaki jest Twój ulubiony zimowy rytuał pielęgnacyjny', platform: 'facebook' });
  assert.equal(comment.flags.creative, false);
  assert.equal(L.hiddenReason(comment, hide), '');
  assert.equal(L.classify({ task: 'Zrób sesję zdjęciową w studiu LILOU' }).flags.creative, false);
});

test('platforma z adresu', () => {
  assert.equal(L.platformOf('https://www.facebook.com/share/p/1E1CNJQ1Vb/'), 'facebook');
  assert.equal(L.platformOf('https://m.facebook.com/story.php?id=1'), 'facebook');
  assert.equal(L.platformOf('https://www.instagram.com/p/DffJ5O-Cj4-/'), 'instagram');
  assert.equal(L.platformOf('https://example.com/konkurs'), 'www');
  assert.equal(L.platformOf('nie-adres'), 'www');
});

test('szansa: nowsza liczba komentarzy wygrywa, ręczna liczba nagród ma pierwszeństwo', () => {
  const c = { comments: 100, commentsAt: '2026-11-18', prizeCount: 4 };
  assert.equal(L.oddsOf(c, {}), 25);
  assert.equal(L.oddsOf(c, { comments: 300, commentsAt: '2026-11-20' }), 75);
  assert.equal(L.oddsOf(c, { comments: 10, commentsAt: '2026-11-01' }), 25);
  assert.equal(L.oddsOf(c, { prizes: 1 }), 100);
  assert.equal(L.oddsOf({ prizeCount: 3 }, {}), null);
});

test('stan: czyszczenie i łączenie (wygrywa nowsza zmiana)', () => {
  const a = { items: { x: { s: 'submitted', at: '2026-11-20', t: 10 }, y: { s: 'todo', t: 5 } }, settings: { t: 1, ntfy: { topic: 'aaa' } } };
  const b = { items: { x: { s: '', t: 5 }, y: { s: 'skipped', t: 9 }, z: { s: 'won', t: 1, evil: '<script>' } }, settings: { t: 2, ntfy: { topic: 'bbb' } } };
  const m = L.mergeStates(a, b);
  assert.equal(m.items.x.s, 'submitted');
  assert.equal(m.items.y.s, 'skipped');
  assert.equal(m.items.z.s, 'won');
  assert.equal(m.items.z.evil, undefined);
  assert.equal(m.settings.ntfy.topic, 'bbb');
  assert.equal(m.settings.hide.party, true);
  assert.ok(L.sameState(m, L.mergeStates(b, a)));
  assert.deepEqual(L.normalizeState('śmieci'), L.emptyState());
  // nowsze ustawienia bez kanału ntfy nie kasują kanału z drugiego urządzenia
  const keep = L.mergeStates({ settings: { t: 9, hide: { party: false } } }, { settings: { t: 1, ntfy: { topic: 'konkursy-abc' } } });
  assert.equal(keep.settings.ntfy.topic, 'konkursy-abc');
  assert.equal(keep.settings.hide.party, false);
  assert.equal(L.normalizeState({ items: { q: { s: 'zly-status', t: 1 } } }).items.q.s, undefined);
});

test('lista: katalog + ręczne + archiwalne zgłoszenia', () => {
  const catalog = { contests: [{ id: 'ek:a', title: 'A', end: '2026-11-25' }] };
  const state = L.normalizeState({
    manual: { 'm:1': { title: 'M', end: '2026-11-30', t: 1 }, 'm:2': { title: 'Usunięty', deleted: true, t: 2 } },
    items: { 'ek:old': { s: 'submitted', t: 1, snap: { title: 'Stary', end: '2026-10-01' } } },
  });
  const ids = L.allContests(catalog, state).map((c) => c.id);
  assert.deepEqual(ids, ['ek:a', 'm:1', 'ek:old']);
});

test('powiadomienia: kończące się, nowe noclegi, wyniki', () => {
  const today = '2026-11-20';
  const contests = [
    { id: 'a', title: 'Jutro koniec', end: '2026-11-21', comments: 40, prizeCount: 2, flags: {} },
    { id: 'b', title: 'Dziś koniec, słaba szansa', end: '2026-11-20', comments: 5000, prizeCount: 1, flags: {} },
    { id: 'c', title: 'Dziś koniec, planuję', end: '2026-11-20', comments: 5000, prizeCount: 1, flags: {} },
    { id: 'd', title: 'Impreza', end: '2026-11-21', flags: { party: true } },
    { id: 'e', title: 'Nowy hotel', end: '2026-12-10', firstSeen: today, flags: { stay: true } },
    { id: 'f', title: 'Zgłoszony', end: '2026-11-17', flags: {} },
    { id: 'g', title: 'Zgłoszony z datą wyników', end: '2026-11-10', results: today, flags: {} },
  ];
  const state = L.normalizeState({
    items: { c: { s: 'todo', t: 1 }, f: { s: 'submitted', t: 1 }, g: { s: 'submitted', t: 1 } },
    settings: { t: 1, ntfy: { topic: 'konkursy-test', days: [1, 0] } },
  });
  const p = L.pickNotifications(contests, state, today);
  assert.deepEqual(p.ending.map((e) => e.c.id), ['c', 'a']);
  assert.deepEqual(p.newStays.map((e) => e.c.id), ['e']);
  assert.deepEqual(p.results.map((e) => e.c.id).sort(), ['f', 'g']);
  const msg = L.buildDigest(p, { appUrl: 'https://example.github.io/konkursy/' });
  assert.match(msg.title, /2 konkursy kończą się/);
  assert.match(msg.message, /Dziś: Dziś koniec, planuję/);
  assert.equal(msg.priority, 4);
  assert.equal(msg.click, 'https://example.github.io/konkursy/');
  assert.equal(L.buildDigest({ ending: [], newStays: [], results: [] }), null);
});

test('nagrody: rodzaj i wartość', () => {
  const iphone = L.prizeInfo({ prizes: '1x smartfon iPhone Duo' });
  assert.deepEqual(iphone, { kind: 'tech', value: 5000, estimated: true, tier: 'top' });
  const card = L.prizeInfo({ prizes: 'I nagroda: karta o wartości 1500 zł\nII nagroda: karta o wartości 1000 zł', flags: { stay: true } });
  assert.deepEqual(card, { kind: 'trip', value: 1500, estimated: false, tier: 'high' });
  assert.equal(L.prizeInfo({ prizes: '1x obudowa be quiet! o wartości 1 149 zł\n1x chłodzenie 360mm 3x120mm o wartości 849 zł' }).value, 1149);
  assert.equal(L.prizeInfo({ prizes: 'voucher na wyjazd do Egiptu o wartości 9 431,48 zł oraz 1 048 zł', flags: { stay: true } }).value, 9431);
  assert.deepEqual(L.prizeInfo({ prizes: '10x bon do Zalando o wartości 1.000 zł 100x bon o wartości 500 zł' }), { kind: 'voucher', value: 1000, estimated: false, tier: 'high' });
  assert.deepEqual(L.prizeInfo({ prizes: '4x zestaw: airfryer oraz box z produktami (wartość zestawu ok. 650 zł)' }), { kind: 'tech', value: 650, estimated: false, tier: 'mid' });
  assert.deepEqual(L.prizeInfo({ prizes: '5 zestawów po 12 dżemów Stovit!' }), { kind: 'other', value: null, estimated: false, tier: null });
  assert.equal(L.prizeInfo({ prizes: 'Wejściówki na dyskotekę' }).kind, 'other');
  assert.equal(L.prizeInfo({ title: 'Wygraj hulajnogę elektryczną', prizes: '' }).kind, 'tech');
  assert.equal(L.isValuable(L.prizeInfo({ prizes: 'Kalendarz adwentowy' })), false);
  assert.equal(L.formatPLN(5600), '5 600 zł');
});

test('powiadomienia: nowa wartościowa nagroda', () => {
  const today = '2026-11-21';
  const contests = [
    { id: 'tv', title: 'Wygraj telewizor', prizes: '1x telewizor o wartości 3 999 zł', end: '2026-12-01', firstSeen: today, flags: {} },
    { id: 'jam', title: 'Dżemy', prizes: '5 zestawów dżemów', end: '2026-12-01', firstSeen: today, flags: {} },
    { id: 'old', title: 'Stary telefon', prizes: '1x smartfon', end: '2026-12-01', firstSeen: '2026-11-01', flags: {} },
  ];
  const state = L.normalizeState({ settings: { t: 1, ntfy: { topic: 'konkursy-test', days: [] } } });
  const p = L.pickNotifications(contests, state, today);
  assert.deepEqual(p.newValuable.map((e) => e.c.id), ['tv']);
  const msg = L.buildDigest(p);
  assert.match(msg.message, /💎 Nowa nagroda – 3 999 zł: Wygraj telewizor/);
  assert.match(msg.title, /1 wartościowa nagroda/);
});

test('odświeżanie: rozpoznanie uruchomienia robota i link do tokenu', () => {
  const runs = [{ id: 1, display_title: 'Robot' }, { id: 2, display_title: 'Robot (odświeżenie ab12cd)' }];
  assert.equal(L.findDispatchedRun(runs, 'ab12cd').id, 2);
  assert.equal(L.findDispatchedRun(runs, 'zzz'), null);
  assert.equal(L.findDispatchedRun(runs, ''), null);
  const url = new URL(L.tokenTemplateUrl());
  assert.equal(url.pathname, '/settings/personal-access-tokens/new');
  assert.equal(url.searchParams.get('gists'), 'write');
  assert.equal(url.searchParams.get('actions'), 'write');
  assert.ok(url.searchParams.get('name').length <= 40);
});

test('odmiana i losowa nazwa kanału', () => {
  assert.equal(L.plural(1, ['konkurs', 'konkursy', 'konkursów']), 'konkurs');
  assert.equal(L.plural(3, ['konkurs', 'konkursy', 'konkursów']), 'konkursy');
  assert.equal(L.plural(12, ['konkurs', 'konkursy', 'konkursów']), 'konkursów');
  assert.equal(L.plural(22, ['konkurs', 'konkursy', 'konkursów']), 'konkursy');
  assert.match(L.randomTopic(), /^konkursy-[a-z2-9]{14}$/);
});
