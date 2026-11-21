import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCurated } from '../robot/scrape.mjs';

test('robot: konkursy spoza e-konkursy z data/curated.json', () => {
  const today = '2026-11-21';
  const byId = new Map([
    ['ek:a', { id: 'ek:a', title: 'A', end: '2026-11-30', comments: 10, commentsAt: '2026-11-21', flags: { stay: false } }],
    ['ek:b2b', { id: 'ek:b2b', title: 'Tylko dla partnerów', end: '2026-12-13', flags: {} }],
  ]);
  applyCurated(
    byId,
    {
      _info: { note: 'opis pliku' },
      'ek:b2b': { exclude: true },
      'ek:a': { comments: 5, commentsAt: '2026-11-20', answers: ['odp'], flags: { stay: true } },
      'ek:brak': { comments: 1 },
      'web:auto': {
        title: 'Loteria – wygraj Škodę Fabię',
        org: 'Manufaktura',
        url: 'https://example.com/loteria',
        end: '2026-11-27',
        task: 'Zrób zakupy za min. 100 zł i zarejestruj paragon w punkcie loterii.',
        prizes: '• 1x samochód Škoda Fabia\n• 186x nagroda natychmiastowa',
        location: 'Łódź',
        comments: 0,
        commentsAt: '2026-11-21',
      },
      'web:stary': { title: 'Dawno po terminie', end: '2026-08-01', prizes: 'kubek' },
      'web:niepelny': { title: 'Bez daty końca' },
    },
    today,
  );
  const a = byId.get('ek:a');
  assert.equal(a.comments, 10); // nowsza liczba z katalogu zostaje
  assert.deepEqual(a.answers, ['odp']);
  assert.equal(a.flags.stay, true);
  assert.equal(byId.has('ek:brak'), false);
  assert.equal(byId.has('ek:b2b'), false);
  const w = byId.get('web:auto');
  assert.equal(w.origin, 'web');
  assert.equal(w.platform, 'www');
  assert.equal(w.src, 'https://example.com/loteria');
  assert.equal(w.firstSeen, today);
  assert.equal(w.prizeCount, 187);
  assert.equal(w.flags.purchase, true);
  assert.equal(w.local, true);
  assert.equal(w.comments, 0);
  assert.equal(byId.has('web:stary'), false);
  assert.equal(byId.has('web:niepelny'), false);
  // kolejny przebieg: wpis już jest w katalogu, data pierwszego pojawienia się nie zmienia
  w.firstSeen = '2026-11-20';
  applyCurated(byId, { 'web:auto': { title: 'Loteria – wygraj Škodę Fabię', end: '2026-11-27' } }, '2026-11-22');
  assert.equal(byId.get('web:auto').firstSeen, '2026-11-20');
});
