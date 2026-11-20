import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, htmlToText, parseDetail, parseListing, hasNextPage, locationFromTitle } from '../robot/parse.mjs';

// Uproszczony fragment o tej samej strukturze co strona konkursu na e-konkursy.info (treść zmyślona).
const DETAIL = `
<ol class="breadcrumb m-l-0 m-r-0">
  <li><a href="https://www.e-konkursy.info/konkursy">Konkursy</a></li>
  <li><a href="https://www.e-konkursy.info/konkursy/konkursy-social-media">Konkursy Social Media</a></li>
  <li class="active"><a href="https://www.e-konkursy.info/konkursy/konkursy-lokalne">Konkursy lokalne</a></li>
</ol>
<div id="blog" class="single-post">
  <span class="label label-success right p-1">Do zakończenia <span>12</span> dni</span>  <h2 class="h5 font-weight-700">Kraków: Wygraj weekend &quot;W górach&quot;</h2>
  <li class="post-meta-date">Konkurs trwa od   <span class="badge">2026-11-17</span></li>
  <li class="post-meta-date"> Konkurs trwa do   <span class="badge">2026-12-02</span></li>
  <li class="post-meta-category"><i class="fa fa-tag"></i> Organizator   <strong>Pensjonat &amp; Spa</strong></li>
  <h3 class="m-b-0">Opis konkursu</h3>
  <div class="m-b-5">Odpowiedz w komentarzu na pytanie:<br />
<b>Kogo zabierzesz?</b><br />
Wyniki ogłosimy 5.12.2026.</div>
  <h3 class="m-b-0">Nagrody</h3>
  <div class="m-0 p-0">2x pobyt dla 2 osób</div>
  <p class="text-center">
    <a href="https://www.facebook.com/share/p/abc/?a=1&amp;b=2"
       class="btn btn-success" rel="nofollow external noopener" target="_blank">Przejdź do strony z konkursem<i class="fa fa-arrow-right"></i></a>
  </p>
  <div class="post-tags m-b-0"><a href="https://www.e-konkursy.info/tagi/pobyt" rel="tag">pobyt</a> <a href="https://www.e-konkursy.info/tagi/krak%C3%B3w" rel="tag">kraków</a></div>
</div>`;

test('encje i tekst z HTML', () => {
  assert.equal(decodeEntities('&quot;A&quot; &amp; B &#8211; &#x105; &bdquo;C&rdquo; &nieznana;'), '"A" & B – ą „C” &nieznana;');
  assert.equal(htmlToText('<p>Ala<br>ma <b>kota</b></p><ul><li>jeden</li><li>dwa</li></ul><script>x()</script>'), 'Ala\nma kota\n\n• jeden\n• dwa');
  assert.equal(htmlToText('Pierwsza linia<br />\nDruga\n   linia'), 'Pierwsza linia\nDruga linia');
});

test('strona konkursu', () => {
  const d = parseDetail(DETAIL);
  assert.equal(d.title, 'Kraków: Wygraj weekend "W górach"');
  assert.equal(d.start, '2026-11-17');
  assert.equal(d.end, '2026-12-02');
  assert.equal(d.org, 'Pensjonat & Spa');
  assert.equal(d.task, 'Odpowiedz w komentarzu na pytanie:\nKogo zabierzesz?\nWyniki ogłosimy 5.12.2026.');
  assert.equal(d.prizes, '2x pobyt dla 2 osób');
  assert.equal(d.url, 'https://www.facebook.com/share/p/abc/?a=1&b=2');
  assert.equal(d.status, 'Do zakończenia 12 dni');
  assert.deepEqual(d.cats, ['konkursy-social-media', 'konkursy-lokalne']);
  assert.deepEqual(d.tags, ['pobyt', 'kraków']);
  assert.equal(locationFromTitle(d.title), 'Kraków');
  assert.equal(locationFromTitle('Wygraj kalendarz'), null);
});

test('lista konkursów i stronicowanie', () => {
  const html = `<a href="https://www.e-konkursy.info/konkurs/konkurs-a">A</a>
    <a href="https://www.e-konkursy.info/konkurs/konkurs-a" tabindex="-1">A</a>
    <a href="https://www.e-konkursy.info/konkurs/wygraj-b-2">B</a>
    <a class="page-link" href="https://www.e-konkursy.info/konkursy/konkursy-na-facebooku?strona=2">2</a>`;
  assert.deepEqual(parseListing(html), ['konkurs-a', 'wygraj-b-2']);
  assert.equal(hasNextPage(html, 1), true);
  assert.equal(hasNextPage(html, 2), false);
});
