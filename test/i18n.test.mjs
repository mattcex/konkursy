import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { translator, detectLang, keys } from '../site/i18n.js';
import * as L from '../site/logic.js';

const placeholders = (v) => (typeof v === 'string' ? [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',') : '');

test('tłumaczenia: te same klucze i zmienne w PL i EN', () => {
  const pl = keys('pl');
  const en = keys('en');
  assert.deepEqual(pl.filter((k) => !en.includes(k)), [], 'brak w EN');
  assert.deepEqual(en.filter((k) => !pl.includes(k)), [], 'brak w PL');
  const tpl = translator('pl');
  const ten = translator('en');
  for (const k of pl) {
    const a = tpl.t(k);
    const b = ten.t(k);
    if (typeof a === 'string') assert.equal(placeholders(b), placeholders(a), `zmienne w „${k}”`);
  }
});

test('tłumaczenia: każdy klucz użyty w app.js istnieje', () => {
  const src = readFileSync(new URL('../site/app.js', import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/\bt[n]?\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]));
  const known = new Set(keys('pl'));
  const missing = [...used].filter((k) => !known.has(k));
  assert.deepEqual(missing, []);
});

test('tłumaczenia: odmiana, kwoty i wykrywanie języka', () => {
  const pl = translator('pl');
  const en = translator('en');
  assert.equal(pl.tn('list.count', 1), '1 konkurs');
  assert.equal(pl.tn('list.count', 3), '3 konkursy');
  assert.equal(pl.tn('list.count', 12), '12 konkursów');
  assert.equal(en.tn('list.count', 1), '1 contest');
  assert.equal(en.tn('list.count', 5), '5 contests');
  assert.equal(pl.money(5600), '5 600 zł');
  assert.equal(en.money(5600), 'PLN 5,600');
  assert.equal(pl.t('nieistniejący.klucz'), 'nieistniejący.klucz');
  assert.equal(detectLang(['pl-PL', 'en']), 'pl');
  assert.equal(detectLang(['en-US']), 'en');
  assert.equal(detectLang(['de-DE']), 'en');
  assert.equal(detectLang([]), 'pl');
});

test('powiadomienie po angielsku', () => {
  const p = {
    ending: [{ c: { title: 'Win a TV' }, dl: 1, odds: 12, todo: false }],
    newStays: [],
    newValuable: [{ c: { title: 'Hotel weekend' }, odds: null, info: { value: 1200, estimated: true } }],
    results: [],
  };
  const msg = L.buildDigest(p, { lang: 'en' });
  assert.equal(msg.title, 'Lootsy: 1 contest ending, 1 valuable prize');
  assert.match(msg.message, /⏰ Tomorrow: Win a TV \(odds 1:12\)/);
  assert.match(msg.message, /💎 New prize – ~PLN 1,200: Hotel weekend/);
  assert.equal(L.settingsOf({ settings: { lang: 'en' } }).lang, 'en');
  assert.equal(L.settingsOf({ settings: { lang: 'xx' } }).lang, 'auto');
});
