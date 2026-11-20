// Parsowanie stron e-konkursy.info (bez zależności – wyrażenia regularne na HTML).

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  ndash: '–', mdash: '—', hellip: '…', bdquo: '„', rdquo: '”', ldquo: '“', lsquo: '‘', rsquo: '’', sbquo: '‚',
  oacute: 'ó', Oacute: 'Ó', middot: '·', bull: '•', times: '×', euro: '€', copy: '©', reg: '®', deg: '°',
};

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.hasOwn(NAMED, e) ? NAMED[e] : m;
  });
}

export function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/\s+/g, ' ') // jak w przeglądarce: znaki nowej linii w źródle to zwykłe spacje
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n• ')
      .replace(/<\/(p|div|ul|ol|h\d|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const oneLine = (s) => htmlToText(s).replace(/\s+/g, ' ').trim();

/** Adresy (slugi) konkursów z listy kategorii. */
export function parseListing(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/href="https:\/\/www\.e-konkursy\.info\/konkurs\/([a-z0-9-]+)"/gi)) {
    const slug = m[1].toLowerCase();
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  }
  return out;
}

export function hasNextPage(html, page) {
  return new RegExp(`[?&;]strona=${page + 1}(&|")`).test(String(html || ''));
}

/** Dane konkursu ze strony szczegółów. */
export function parseDetail(html) {
  const h = String(html || '');
  const pick = (re) => {
    const m = h.match(re);
    return m ? m[1] : null;
  };
  const title = oneLine(pick(/<h2 class="h5 font-weight-700">([\s\S]*?)<\/h2>/) || '');
  const start = pick(/Konkurs trwa od\s*<span class="badge">(\d{4}-\d{2}-\d{2})/);
  const end = pick(/Konkurs trwa do\s*<span class="badge">(\d{4}-\d{2}-\d{2})/);
  const org = oneLine(pick(/Organizator\s*<strong>([\s\S]*?)<\/strong>/) || '');
  const task = htmlToText(pick(/<h3 class="m-b-0">Opis konkursu<\/h3>\s*<div[^>]*>([\s\S]*?)<\/div>/) || '');
  const prizes = htmlToText(pick(/<h3 class="m-b-0">Nagrody<\/h3>\s*<div[^>]*>([\s\S]*?)<\/div>/) || '');
  const rawUrl = pick(/<a href="([^"]+)"[^>]*>\s*Przejdź do strony z konkursem/);
  const url = rawUrl ? decodeEntities(rawUrl) : null;
  const status = oneLine(pick(/<span class="label[^"]*">([\s\S]*?)<\/span>\s*<h2/) || '');
  const crumbs = (h.match(/<ol class="breadcrumb[\s\S]*?<\/ol>/) || [''])[0];
  const cats = [...crumbs.matchAll(/\/konkursy\/([a-z0-9-]+)"/g)].map((m) => m[1]);
  const tags = [...h.matchAll(/\/tagi\/([^"]+)" rel="tag"/g)].map((m) => {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  });
  return { title, start, end, org, task, prizes, url, status, cats, tags };
}

/** „Wrocław: Konkurs …” → „Wrocław” (e-konkursy tak oznacza konkursy lokalne). */
export function locationFromTitle(title) {
  const m = String(title || '').match(/^([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+(?:[ -][A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]+)?):\s/);
  return m ? m[1] : null;
}
