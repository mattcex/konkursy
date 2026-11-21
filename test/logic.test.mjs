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
  assert.equal(L.hiddenReason(essay, hide), 'creative');
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

test('dla Ciebie: góry, narty, samochód, Fujifilm', () => {
  const of = (c) => L.interestsOf({ flags: {}, ...c });
  assert.deepEqual(of({ title: 'Wygraj pobyt', prizes: 'Pobyt dla dwóch osób w hotelu z widokiem na Giewont i strefą SPA' }), ['mountains']);
  assert.deepEqual(of({ title: 'Wielki konkurs', prizes: 'karta o wartości 1500 zł na pobyt', location: 'Zakopane' }), ['mountains']);
  assert.deepEqual(of({ title: 'Konkurs Beskidzkie', prizes: '400x Bluza Beskidzkie' }), []); // marka, nie wyjazd
  assert.deepEqual(of({ title: 'SNOW EXPO', prizes: 'voucher na wyjazd narciarski 3000 zł' }), ['ski']);
  assert.deepEqual(of({ title: 'Wygraj deskę', prizes: '1x deska snowboardowa' }), ['ski']);
  assert.deepEqual(of({ title: 'Loteria', prizes: '• Nagroda Główna: samochód osobowy MINI Cooper' }), ['car']);
  assert.deepEqual(of({ title: 'Loteria', prizes: '• główna: Toyota Yaris Cross' }), ['car']);
  assert.deepEqual(of({ title: 'Konkurs', prizes: '5x fotelik samochodowy' }), []);
  assert.deepEqual(of({ title: 'GBS', prizes: 'konsola PlayStation 5 + gra Grand Theft Auto VI' }), []);
  assert.deepEqual(of({ title: 'Braun', prizes: '4x podwójna wejściówka na wyścig Audi Revolut F1® Team' }), []);
  assert.deepEqual(of({ title: 'Autopay - wygraj nagrody', prizes: 'karta Travelplanet' }), []);
  assert.deepEqual(of({ title: '20 lat uśmiechów', prizes: '3x aparat FUJIFILM Instax Mini 41' }), ['fujifilm']);
  // tylko wybrane zainteresowania
  assert.deepEqual(L.interestsOf({ title: 'x', prizes: '3x aparat Instax' }, {}, ['car']), []);
});

test('dla Ciebie: pieniądze bez bonów, wartości rzeczy i dopłat na podatek', () => {
  const money = (p) => L.hasMoneyPrize(p);
  assert.equal(money('4200x nagroda pieniężna w wysokości 1000 zł'), true);
  assert.equal(money('• 2x 10 000 zł\n• 25x karta Zalando 500 zł'), true);
  assert.equal(money('• Nagroda Główna: 60 000 zł (oraz dodatkowa kwota 6 667 zł na pokrycie podatku)'), true);
  assert.equal(money('Nagroda główna 100 000 zł oraz nagrody rzeczowe za wymianę punktów'), true);
  assert.equal(money('• tygodniowa: 13x 5000 zł ( 1 / tydzień)'), true);
  assert.equal(money('• 50x Nagroda II stopnia: 1 000 zł przelewem na konto'), true);
  assert.equal(money('• 1x Nagroda Główna: 50 000 zł w gotówce'), true);
  assert.equal(money('• 5x voucher wakacyjny 20 000 zł\n• 20x voucher Booksy 1 000 zł'), false);
  assert.equal(money('• 10x bon na zakupy o wartości 600 zł'), false);
  assert.equal(money('• 1 miejsce: Suszarka Lovello (499 zł), ręcznik (119 zł)\nŁączna wartość nagrody: 1 945,83 zł'), false);
  assert.equal(money('10x zestaw Dilmah o wartości 100 zł (z dodatkową nagrodą pieniężną na pokrycie podatku)'), false);
  assert.equal(money('2x 4-osobowy pobyt w Hotelu Arłamów z kartą przedpłaconą 500 zł oraz nagrodą pieniężną'), false);
  assert.equal(money('Bon 500 zł. Nagrody nie mogą być wymienione na gotówkę ani inną rekompensatę.'), false);
  assert.equal(money('• 2x samochód Citroën C3 (oraz 7 500 zł na wybrany cel dobroczynny)'), false);
});

test('dla Ciebie: duża szansa (bez liczenia w dniu publikacji)', () => {
  const settings = L.settingsOf({});
  assert.deepEqual(settings.interests, { list: L.INTERESTS });
  const odds = { id: 'o', title: 'Kubek', prizes: 'kubek', comments: 90, prizeCount: 3, flags: {} };
  assert.deepEqual(L.interestsOf(odds), ['odds']); // 1:30
  assert.deepEqual(L.interestsOf({ ...odds, comments: 900 }), []);
  // świeży post: komentarze policzone w dniu publikacji – to jeszcze nie „duża szansa”
  const fresh = { ...odds, start: '2026-11-21', commentsAt: '2026-11-21' };
  assert.equal(L.earlyCount(fresh), true);
  assert.deepEqual(L.interestsOf(fresh), []);
  assert.deepEqual(L.interestsOf({ ...fresh, commentsAt: '2026-11-23' }), ['odds']);
  const off = L.settingsOf({ settings: { interests: { list: ['car', 'nieznane'] } } });
  assert.deepEqual(off.interests.list, ['car']);
});

test('z zakupem: osobna kategoria zamiast ukrywania', () => {
  const settings = L.settingsOf({ settings: { hide: { purchase: true, app: true, party: true } } }); // starsze ustawienia
  assert.equal('purchase' in settings.hide, false);
  const car = { id: 'c', title: 'Loteria', prizes: '1x samochód Volvo XC40', flags: { purchase: true } };
  assert.equal(L.needsPurchase(car), true);
  assert.equal(L.needsPurchase({ flags: { app: true } }), true);
  assert.equal(L.needsPurchase({ flags: {} }), false);
  assert.equal(L.hiddenReason(car, settings.hide), ''); // nie jest ukryty – trafia do sekcji „Z zakupem”
  assert.equal(L.hiddenReason({ flags: { purchase: true, fbShare: true } }, settings.hide), 'fbShare');
  const p = (task, cats) => L.classify({ task, cats }).flags.purchase;
  assert.equal(p('Uczestnik musi zakupić produkt promocyjny SMEG w sklepie Auchan'), true);
  assert.equal(p('• Zrób co najmniej jeden zakup u partnera programu'), true);
  assert.equal(p('• Płać BLIK-iem przy użyciu kodu z aplikacji'), true);
  assert.equal(p('Należy zawrzeć w Banku umowę na produkt promocyjny.'), true);
  assert.equal(p('Wpisuj kody spod wieczek opakowań.'), true);
  assert.equal(p('Odwiedź lokal i zamów jeden z napojów sezonowych'), true);
  assert.equal(p('Opis', ['konkursy-promocyjne']), true);
  assert.equal(p('Nie musisz nic kupować ani kupić – wystarczy komentarz.'), false);
  assert.equal(p('Robicie listę zakupów do M Park – co kupicie na literę M?'), false);
  assert.equal(p('Napisz w komentarzu, na co wydasz bon na zakupy'), false);
});

test('powiadomienia: nowe konkursy dla Ciebie, loterie z zakupem osobno', () => {
  const today = '2026-11-21';
  const contests = [
    { id: 'car', title: 'Loteria InPost', prizes: '• 10x samochód MINI Cooper', end: '2027-01-28', firstSeen: today, flags: { purchase: true } },
    { id: 'hotel', title: 'Nowy hotel nad morzem', prizes: 'pobyt w hotelu', end: '2026-12-10', firstSeen: today, flags: { stay: true } },
    { id: 'promo', title: 'Loteria z kubkami', prizes: 'kubek', end: '2026-11-22', firstSeen: '2026-11-01', flags: { purchase: true } },
  ];
  const state = L.normalizeState({ settings: { t: 1, ntfy: { topic: 'konkursy-test', days: [1] } } });
  const p = L.pickNotifications(contests, state, today);
  assert.deepEqual(p.newInterests.map((e) => e.c.id), ['car']);
  assert.deepEqual(p.newStays.map((e) => e.c.id), ['hotel']);
  assert.deepEqual(p.ending, []); // loterii bez gwiazdki nie przypominamy
  const msg = L.buildDigest(p);
  assert.match(msg.message, /🎯 Dla Ciebie \(samochód\): Loteria InPost · z zakupem/);
  assert.match(msg.title, /1 nowy dla Ciebie/);
  assert.ok(msg.tags.includes('dart'));
  const off = L.normalizeState({ settings: { t: 1, ntfy: { topic: 'konkursy-test', days: [], newPurchase: false } } });
  assert.deepEqual(L.pickNotifications(contests, off, today).newInterests, []);
});
