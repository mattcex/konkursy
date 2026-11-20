// Konkursy – aplikacja (GitHub Pages). Bez zależności i bez kroku budowania.
import * as L from './logic.js';

const K = { state: 'konkursy.state.v1', sync: 'konkursy.sync.v1', ui: 'konkursy.ui.v1', theme: 'konkursy.theme', catalog: 'konkursy.catalog.v1' };
const $ = (sel) => document.querySelector(sel);

// ---------- pamięć przeglądarki ----------

function lsGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function lsSet(key, value) {
  try {
    if (value === null || value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* tryb prywatny / brak miejsca – aplikacja działa dalej bez zapisu */
  }
}

// ---------- stan ----------

let catalog = { contests: [], updatedAt: null };
let catalogError = '';
let state = L.normalizeState(lsGet(K.state));
let ui = { tab: 'open', q: '', cat: 'all', sort: 'deadline', showHidden: false, ...(lsGet(K.ui) || {}) };
if (ui.cat === 'stay') ui.cat = 'trip'; // starsza wersja ustawień
if (!['all', ...L.KIND_ORDER].includes(ui.cat)) ui.cat = 'all';
if (!['deadline', 'odds', 'value', 'new'].includes(ui.sort)) ui.sort = 'deadline';
let sync = lsGet(K.sync);
let syncInfo = { kind: sync ? 'busy' : 'local', msg: sync ? 'Łączenie…' : 'Tylko to urządzenie', at: null };
let openId = null;

const site = (() => {
  const host = location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.split('.')[0];
    const repo = location.pathname.split('/').filter(Boolean)[0] || host;
    return { owner, repo, repoUrl: `https://github.com/${owner}/${repo}`, appUrl: location.origin + location.pathname.replace(/index\.html$/, '') };
  }
  return { owner: 'lokalnie', repo: 'konkursy', repoUrl: '', appUrl: location.origin + location.pathname.replace(/index\.html$/, '') };
})();

function saveLocal() {
  lsSet(K.state, state);
}
function saveUi() {
  lsSet(K.ui, { tab: ui.tab, cat: ui.cat, sort: ui.sort, showHidden: ui.showHidden });
}

/** Zapis zmiany: localStorage, odświeżenie listy i (z opóźnieniem) synchronizacja. */
function commit() {
  saveLocal();
  render();
  scheduleSync();
}

function snapOf(c) {
  const s = {};
  for (const k of ['title', 'url', 'end', 'prizes', 'org', 'src']) if (typeof c[k] === 'string' && c[k]) s[k] = c[k].slice(0, 2000);
  return s;
}

function setItem(id, patch) {
  const next = { ...(state.items[id] || {}), ...patch, t: Date.now() };
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null || next[k] === '') delete next[k];
  state.items[id] = next;
  commit();
}

function setStatus(c, s) {
  const it = state.items[c.id] || {};
  const patch = { s };
  if (L.DONE.has(s)) {
    patch.at = it.at || L.todayISO();
    if (!c.gone) patch.snap = snapOf(c);
  } else {
    patch.at = undefined;
  }
  setItem(c.id, patch);
}

function setSettings(mutate) {
  const s = L.settingsOf(state);
  mutate(s);
  s.t = Date.now();
  state.settings = s;
  commit();
}

// ---------- synchronizacja (prywatny gist) ----------

let syncTimer = null;
let syncing = false;
let syncAgain = false;
let lastPull = 0;

function setSync(kind, msg) {
  syncInfo = { kind, msg, at: kind === 'ok' ? new Date() : syncInfo.at };
  renderSyncButton();
}

async function gh(path, { method = 'GET', body, token = sync && sync.token } = {}) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`GitHub: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function readGistState(gistId) {
  const g = await gh(`/gists/${encodeURIComponent(gistId)}`);
  const f = g.files && g.files[L.STATE_FILE];
  if (!f) return L.emptyState();
  const text = f.truncated ? await (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content;
  return L.normalizeState(JSON.parse(text || '{}'));
}

async function connect(token) {
  token = token.trim();
  if (!token) throw new Error('Wklej token.');
  const user = await gh('/user', { token });
  let gistId = null;
  for (let page = 1; page <= 10 && !gistId; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`, { token });
    const found = list.find((g) => g.files && g.files[L.STATE_FILE]);
    if (found) gistId = found.id;
    if (list.length < 100) break;
  }
  if (!gistId) {
    const g = await gh('/gists', {
      token,
      method: 'POST',
      body: {
        description: 'Konkursy – prywatny stan aplikacji (nie usuwaj)',
        public: false,
        files: { [L.STATE_FILE]: { content: JSON.stringify(state, null, 1) } },
      },
    });
    gistId = g.id;
  }
  sync = { token, gistId, login: user.login };
  lsSet(K.sync, sync);
  await syncNow();
  return user.login;
}

function disconnect() {
  sync = null;
  lsSet(K.sync, null);
  setSync('local', 'Tylko to urządzenie');
}

/** Pobiera stan z gista, łączy z lokalnym i zapisuje wynik w obu miejscach. */
async function syncNow() {
  if (!sync) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  setSync('busy', 'Synchronizuję…');
  try {
    const remote = await readGistState(sync.gistId);
    const merged = L.mergeStates(state, remote);
    const localChanged = !L.sameState(merged, state);
    state = merged;
    saveLocal();
    if (localChanged) {
      render();
      if (openId && $('#dlg-contest').open) renderContest(openId);
    }
    if (!L.sameState(merged, remote)) {
      await gh(`/gists/${encodeURIComponent(sync.gistId)}`, {
        method: 'PATCH',
        body: { files: { [L.STATE_FILE]: { content: JSON.stringify(state, null, 1) } } },
      });
    }
    lastPull = Date.now();
    setSync('ok', 'Zsynchronizowano');
  } catch (e) {
    if (e.status === 401) setSync('err', 'Token wygasł lub jest nieprawidłowy');
    else if (e.status === 404) setSync('err', 'Nie znaleziono gista ze stanem');
    else if (e.status === 403) setSync('err', 'GitHub odmówił dostępu (limit lub uprawnienia)');
    else setSync('err', 'Brak połączenia – spróbuję ponownie');
  } finally {
    syncing = false;
    if (syncAgain) {
      syncAgain = false;
      scheduleSync(300);
    }
  }
}

function scheduleSync(ms = 1200) {
  if (!sync) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, ms);
}

// ---------- odświeżanie listy: uruchomienie robota w GitHub Actions ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let refreshing = null; // opis postępu albo null

function renderRefreshButton() {
  const btn = $('#btn-refresh');
  if (!btn) return;
  btn.disabled = Boolean(refreshing);
  btn.replaceChildren(icon('refresh', { cls: refreshing ? 'spin' : '' }), h('span', { class: 'refresh-text' }, refreshing || 'Odśwież'));
}

function setRefreshing(msg) {
  refreshing = msg;
  renderRefreshButton();
}

const canRunRobot = () => Boolean(sync && site.repoUrl);

async function runRobot() {
  const { owner, repo } = site;
  const requestId = Math.random().toString(36).slice(2, 10);
  await gh(`/repos/${owner}/${repo}/actions/workflows/${L.ROBOT_WORKFLOW}/dispatches`, {
    method: 'POST',
    body: { ref: 'main', inputs: { notify: 'false', request_id: requestId } },
  });
  let run = null;
  for (let i = 0; i < 40 && !run; i++) {
    await sleep(3000);
    const list = await gh(`/repos/${owner}/${repo}/actions/workflows/${L.ROBOT_WORKFLOW}/runs?event=workflow_dispatch&per_page=10`);
    run = L.findDispatchedRun(list.workflow_runs, requestId);
  }
  if (!run) throw new Error('Robot nie wystartował – spróbuj za chwilę');
  const started = Date.now();
  while (run.status !== 'completed') {
    if (Date.now() - started > 8 * 60 * 1000) throw new Error('Robot działa długo – lista odświeży się sama');
    setRefreshing(run.status === 'in_progress' ? 'Robot szuka nowych…' : 'Robot w kolejce…');
    await sleep(5000);
    run = await gh(`/repos/${owner}/${repo}/actions/runs/${run.id}`);
  }
  if (run.conclusion !== 'success') throw new Error(`Robot zakończył się błędem (${run.conclusion})`);
}

/** Świeża lista prosto z repozytorium (GitHub Pages potrafi przez kilka minut pokazywać starą). */
async function loadCatalogFromRepo() {
  const res = await fetch(`https://api.github.com/repos/${site.owner}/${site.repo}/contents/site/data/contests.json?ref=main`, {
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${sync.token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub: HTTP ${res.status}`), { status: res.status });
  setCatalog(await res.json());
}

async function refreshList() {
  if (refreshing) return;
  const before = new Set((catalog.contests || []).map((c) => c.id));
  const robot = canRunRobot();
  setRefreshing(robot ? 'Robot startuje…' : 'Odświeżam…');
  try {
    if (robot) {
      await runRobot();
      setRefreshing('Wczytuję listę…');
      await loadCatalogFromRepo().catch(() => loadCatalog());
    } else {
      await loadCatalog();
    }
    render();
    const added = (catalog.contests || []).filter((c) => !before.has(c.id)).length;
    toast(added ? `Nowe konkursy: ${added} – oznaczone jako „nowy”` : robot ? 'Robot sprawdził – brak nowych konkursów' : 'Lista wczytana ponownie');
    if (!robot && site.repoUrl) setTimeout(() => toast('Połącz token w ustawieniach, żeby „Odśwież” uruchamiał robota'), 2500);
  } catch (e) {
    if (e.status === 401) toast('Token wygasł – wklej nowy w ustawieniach');
    else if (e.status === 403 || e.status === 404) {
      toast('Ten token nie może uruchamiać robota – utwórz nowy w ustawieniach');
      openSettings();
    } else toast(e.message || 'Nie udało się odświeżyć');
  } finally {
    setRefreshing(null);
  }
}

// ---------- narzędzia DOM ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'value' || k === 'selected' || k === 'disabled' || k === 'required') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

const ICONS = {
  open: '<circle cx="8" cy="8" r="6.25"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>',
  done: '<circle cx="8" cy="8" r="6.25"/><path d="M5.3 8.2l1.9 1.9 3.6-3.9"/>',
  closed: '<circle cx="8" cy="8" r="6.25"/><path d="M5.5 8h5"/>',
  skip: '<circle cx="8" cy="8" r="6.25"/><path d="M3.6 12.4l8.8-8.8"/>',
  lost: '<circle cx="8" cy="8" r="6.25"/><path d="M6 6l4 4M10 6l-4 4"/>',
  trophy: '<path d="M5 2.75h6v3.5a3 3 0 0 1-6 0z"/><path d="M5 4H2.75v1a2.25 2.25 0 0 0 2.4 2.25M11 4h2.25v1a2.25 2.25 0 0 1-2.4 2.25"/><path d="M8 9.25v2.5M5.5 13.25h5"/>',
  star: '<path d="M8 1.9l1.85 3.75 4.15.6-3 2.92.71 4.13L8 11.35l-3.71 1.95.71-4.13-3-2.92 4.15-.6z"/>',
  clock: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.25 1.5"/>',
  comment: '<path d="M2.75 3.25h10.5v7.5H7.5L4.75 13v-2.25h-2z"/>',
  sliders: '<path d="M2.5 4h6M11.5 4h2M2.5 8h2M7.5 8h6M2.5 12h7M12.5 12h1"/><circle cx="10" cy="4" r="1.5"/><circle cx="6" cy="8" r="1.5"/><circle cx="11" cy="12" r="1.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25l3.25 3.25"/>',
  external: '<path d="M9.5 2.75h3.75V6.5M13.25 2.75L7.5 8.5"/><path d="M11.5 9.5v3.25a.5.5 0 0 1-.5.5H3.25a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5H6.5"/>',
  copy: '<rect x="5.25" y="5.25" width="8" height="8" rx="1.25"/><path d="M10.75 5.25V3.5a.75.75 0 0 0-.75-.75H3.5a.75.75 0 0 0-.75.75V10c0 .41.34.75.75.75h1.75"/>',
  bed: '<path d="M1.75 12.75V3.75M1.75 9.75h12.5v3M14.25 9.75V8.25a2 2 0 0 0-2-2H7.25v3.5"/><circle cx="4.5" cy="7.5" r="1.25"/>',
  bell: '<path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1.25 1.25H2.75z"/><path d="M6.5 14h3"/>',
  cloud: '<path d="M4.5 12.25h7a2.75 2.75 0 0 0 .4-5.47A4 4 0 0 0 4.2 6.5a2.9 2.9 0 0 0 .3 5.75z"/>',
  download: '<path d="M8 2.75v7.5M4.75 7.25L8 10.5l3.25-3.25M2.75 13.25h10.5"/>',
  upload: '<path d="M8 10.5V3M4.75 6.25L8 3l3.25 3.25M2.75 13.25h10.5"/>',
  calendar: '<rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.25"/><path d="M2.25 6.5h11.5M5.5 1.75v3M10.5 1.75v3"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.75h5.8l.6-8.75"/>',
  pencil: '<path d="M11 2.75l2.25 2.25-7.5 7.5H3.5v-2.25z"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.46-3.54M13.25 2.5v3h-3"/>',
  people: '<circle cx="6" cy="5.5" r="2.25"/><path d="M2 13c0-2.2 1.8-3.75 4-3.75S10 10.8 10 13M10.5 3.6a2.25 2.25 0 0 1 0 4M12 9.5c1.3.5 2 1.8 2 3.5"/>',
  link: '<path d="M6.75 9.25a2.5 2.5 0 0 0 3.54 0l2-2a2.5 2.5 0 0 0-3.54-3.54l-.75.75M9.25 6.75a2.5 2.5 0 0 0-3.54 0l-2 2a2.5 2.5 0 0 0 3.54 3.54l.75-.75"/>',
  device: '<rect x="2.75" y="3" width="10.5" height="7.25" rx="1"/><path d="M1.25 12.75h13.5"/>',
  gift: '<rect x="2.5" y="6.5" width="11" height="7" rx="1"/><path d="M1.75 4h12.5v2.5H1.75zM8 4v9.5M8 4C7 1.75 4.5 1.75 4.75 3.5M8 4c1-2.25 3.5-2.25 3.25-.5"/>',
  gem: '<path d="M4.5 2.75h7L14 6 8 13.5 2 6z"/><path d="M2 6h12M6.25 2.75L5.5 6 8 13.5 10.5 6l-.75-3.25"/>',
  box: '<path d="M2.5 5L8 2.5 13.5 5v6.5L8 14l-5.5-2.5z"/><path d="M2.5 5L8 7.5 13.5 5M8 7.5V14"/>',
  sparkle: '<path d="M8 1.75l1.4 3.85L13.25 7 9.4 8.4 8 12.25 6.6 8.4 2.75 7 6.6 5.6z"/>',
};

const KIND_ICON = { trip: 'bed', tech: 'device', voucher: 'gift', other: 'box' };

function icon(name, { size = 16, cls = '', fill = false } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('fill', fill ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || ''; // stałe znaczniki z tego pliku
  return svg;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Skopiowano do schowka');
}

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

function extLink(url, label, cls = '') {
  const u = safeUrl(url);
  if (!u) return null;
  return h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: cls }, label, ' ', icon('external', { size: 12 }));
}

// ---------- formatowanie ----------

const MON = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

function fmtDay(iso, withYear = false) {
  if (!L.isISODate(iso)) return '—';
  const [y, m, d] = iso.split('-');
  const cur = L.todayISO().slice(0, 4);
  return `${+d} ${MON[+m - 1]}${withYear || y !== cur ? ' ' + y : ''}`;
}

function rel(dl) {
  if (dl === null) return 'bez terminu';
  if (dl === 0) return 'kończy się dziś';
  if (dl === 1) return 'jutro';
  if (dl > 1) return `za ${dl} dni`;
  if (dl === -1) return 'wczoraj';
  return `${-dl} dni temu`;
}

function dueClass(dl) {
  if (dl === null) return '';
  if (dl < 0) return 'due-past';
  if (dl === 0) return 'due-today';
  if (dl <= 2) return 'due-soon';
  if (dl <= 7) return 'due-week';
  return '';
}

function oddsEl(odds) {
  if (!odds) return h('span', { class: 'odds odds-bad', title: 'Brak liczby komentarzy – wpisz ją w szczegółach' }, '1:?');
  const cls = odds <= 30 ? 'odds-good' : odds <= 100 ? 'odds-ok' : 'odds-bad';
  return h('span', { class: `odds ${cls}`, title: 'Szansa ≈ komentarze ÷ liczba nagród' }, `1:${odds}`);
}

const PLATFORM = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', x: 'X', www: 'strona www' };
const JUDGING = {
  jury: ['jury', 'label-jury', 'Zwycięzców wybiera jury – liczy się pomysł'],
  losowanie: ['losowanie', 'label-draw', 'Zwycięzcy są losowani'],
  reakcje: ['najwięcej reakcji', 'label-warn', 'Wygrywają komentarze z największą liczbą reakcji'],
};

// ---------- widok listy ----------

function rows() {
  const today = L.todayISO();
  const hide = L.settingsOf(state).hide;
  return L.allContests(catalog, state).map((c) => {
    const it = L.itemOf(state, c.id);
    return {
      c,
      it,
      st: it.s || '',
      dl: L.daysLeft(c, today),
      odds: L.oddsOf(c, it),
      comments: L.commentsOf(c, it),
      hidden: L.hiddenReason(c, hide),
      prize: L.prizeInfo(c),
      isNew: !c.manual && L.isISODate(c.firstSeen) && (!catalog.since || c.firstSeen > catalog.since) && L.diffDays(c.firstSeen, today) <= 1,
    };
  });
}

const TABS = [
  { id: 'open', label: 'Otwarte', icon: 'open' },
  { id: 'todo', label: 'Planuję', icon: 'star' },
  { id: 'submitted', label: 'Zgłoszone', icon: 'done' },
  { id: 'results', label: 'Wyniki', icon: 'trophy' },
  { id: 'closed', label: 'Zakończone', icon: 'closed' },
];

function inTab(r, tab, showHidden = ui.showHidden) {
  const active = r.dl === null || r.dl >= 0;
  switch (tab) {
    case 'open':
      return active && !L.DONE.has(r.st) && (showHidden || (r.st !== 'skipped' && !r.hidden));
    case 'todo':
      return active && r.st === 'todo';
    case 'submitted':
      return r.st === 'submitted';
    case 'results':
      return r.st === 'won' || r.st === 'lost';
    case 'closed':
      return !active && !L.DONE.has(r.st) && (showHidden || (r.st !== 'skipped' && !r.hidden));
    default:
      return false;
  }
}

function matches(r) {
  if (ui.cat !== 'all' && r.prize.kind !== ui.cat) return false;
  const q = ui.q.trim().toLowerCase();
  if (!q) return true;
  const hay = [r.c.title, r.c.org, r.c.prizes, r.c.task, r.c.location, r.it.note].join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function sortRows(list) {
  const big = 1e9;
  const byEnd = (a, b) => (a.dl ?? big) - (b.dl ?? big);
  if (ui.sort === 'odds') return list.sort((a, b) => (a.odds ?? big) - (b.odds ?? big) || byEnd(a, b));
  if (ui.sort === 'value') return list.sort((a, b) => (b.prize.value ?? -1) - (a.prize.value ?? -1) || byEnd(a, b));
  if (ui.sort === 'new') return list.sort((a, b) => (b.c.firstSeen || '').localeCompare(a.c.firstSeen || '') || byEnd(a, b));
  if (ui.tab === 'closed' || ui.tab === 'results') return list.sort((a, b) => byEnd(b, a));
  return list.sort((a, b) => byEnd(a, b) || (a.odds ?? big) - (b.odds ?? big));
}

function stateIcon(st, dl) {
  if (st === 'won') return icon('trophy', { cls: 'state-icon state-won' });
  if (st === 'lost') return icon('lost', { cls: 'state-icon state-closed' });
  if (st === 'submitted') return icon('done', { cls: 'state-icon state-done' });
  if (st === 'skipped') return icon('skip', { cls: 'state-icon state-skip' });
  if (dl !== null && dl < 0) return icon('closed', { cls: 'state-icon state-closed' });
  return icon('open', { cls: 'state-icon state-open' });
}

function prizeLabel(p) {
  if (p.value === null) return null;
  const text = `${p.estimated ? '~' : ''}${L.formatPLN(p.value)}`;
  const title = p.estimated ? 'Szacunkowa wartość nagrody (w opisie nie ma kwoty)' : 'Wartość największej nagrody';
  if (p.tier === 'top') return h('span', { class: 'label label-value-top', title }, icon('gem', { size: 12 }), text);
  if (p.tier === 'high') return h('span', { class: 'label label-value', title }, icon('gem', { size: 12 }), text);
  return h('span', { class: 'label', title }, text);
}

function labelsFor(r) {
  const { c, prize } = r;
  const f = L.flagsOf(c);
  const out = [];
  if (r.isNew) out.push(h('span', { class: 'label label-new', title: 'Robot znalazł ten konkurs dziś lub wczoraj' }, icon('sparkle', { size: 12 }), 'nowy'));
  const pl = prizeLabel(prize);
  if (pl) out.push(pl);
  if (f.stay) out.push(h('span', { class: 'label label-stay', title: 'Nocleg, pobyt lub wyjazd' }, icon('bed', { size: 12 }), 'wyjazd'));
  else if (prize.kind === 'tech') out.push(h('span', { class: 'label label-tech', title: 'Sprzęt lub elektronika' }, icon('device', { size: 12 }), 'sprzęt'));
  else if (prize.kind === 'voucher') out.push(h('span', { class: 'label', title: 'Bon, karta podarunkowa lub gotówka' }, icon('gift', { size: 12 }), 'bon'));
  const j = JUDGING[c.judging];
  if (j) out.push(h('span', { class: `label ${j[1]}`, title: j[2] }, j[0]));
  if (c.location) out.push(h('span', { class: 'label label-local', title: 'Konkurs lokalny' }, c.location));
  if (f.fbShare) out.push(h('span', { class: 'label label-danger', title: 'Wymaga udostępnienia posta na Facebooku' }, 'udostępnienie FB'));
  if (f.igShare) out.push(h('span', { class: 'label label-warn', title: 'Wymaga udostępnienia na Instagramie' }, 'udostępnienie IG'));
  if (f.purchase) out.push(h('span', { class: 'label label-danger' }, 'zakup'));
  if (f.app) out.push(h('span', { class: 'label label-warn' }, 'aplikacja'));
  if (f.content) out.push(h('span', { class: 'label label-warn', title: 'Trzeba dodać zdjęcie, film lub grafikę' }, 'zdjęcie/film'));
  if (f.party) out.push(h('span', { class: 'label label-warn' }, 'impreza'));
  if (f.creative) out.push(h('span', { class: 'label label-warn', title: 'Esej, wiersz, opowiadanie, nagranie, projekt albo praca dyplomowa' }, 'praca twórcza'));
  if (c.manual) out.push(h('span', { class: 'label' }, 'dodany ręcznie'));
  if (c.gone) out.push(h('span', { class: 'label', title: 'Konkursu nie ma już na liście robota – pokazuję zapamiętane dane' }, 'archiwum'));
  if (r.hidden && ui.showHidden) out.push(h('span', { class: 'label', title: 'Ukryty przez filtr' }, `ukryty: ${r.hidden}`));
  if (r.st === 'skipped') out.push(h('span', { class: 'label' }, 'pominięty'));
  return out;
}

function itemEl(r) {
  const { c, it, st, dl, odds, comments } = r;
  const isDone = L.DONE.has(st);
  const meta = [];
  const push = (node) => {
    if (meta.length) meta.push(h('span', { class: 'sep', 'aria-hidden': 'true' }));
    meta.push(node);
  };
  if (c.org) push(h('span', null, c.org));
  push(h('span', null, `do ${fmtDay(c.end)}`));
  const prizes = L.prizesOf(c, it);
  if (prizes) push(h('span', null, `${prizes} ${L.plural(prizes, ['nagroda', 'nagrody', 'nagród'])}`));
  if (c.platform && PLATFORM[c.platform]) push(h('span', null, PLATFORM[c.platform]));
  if (isDone && it.at) push(h('span', null, `zgłoszone ${fmtDay(it.at)}`));
  const res = L.resultsOf(c, it);
  if (res && (isDone || st === 'todo')) push(h('span', null, `wyniki ${fmtDay(res)}`));

  const star = h(
    'button',
    {
      type: 'button',
      class: `btn btn-sm btn-invisible btn-icon star${st === 'todo' ? ' on' : ''}`,
      title: st === 'todo' ? 'Usuń z „Planuję”' : 'Dodaj do „Planuję”',
      'aria-pressed': st === 'todo' ? 'true' : 'false',
      'aria-label': 'Planuję',
      disabled: isDone || undefined,
      onclick: () => setStatus(c, st === 'todo' ? '' : 'todo'),
    },
    icon('star', { fill: st === 'todo' }),
  );

  const valuable = L.isValuable(r.prize) && !isDone && (dl === null || dl >= 0);
  return h(
    'div',
    { class: `item${isDone ? ' is-done' : ''}${valuable ? ` is-valuable${r.prize.tier === 'top' ? ' is-top' : ''}` : ''}`, role: 'listitem' },
    h('input', {
      type: 'checkbox',
      class: 'cb',
      checked: isDone,
      title: isDone ? 'Cofnij zgłoszenie' : 'Oznacz jako zgłoszone',
      'aria-label': `Zgłoszone: ${c.title}`,
      onchange: (e) => {
        setStatus(c, e.target.checked ? 'submitted' : '');
        toast(e.target.checked ? 'Oznaczono jako zgłoszone ✓' : 'Cofnięto zgłoszenie');
      },
    }),
    stateIcon(st, dl),
    h(
      'div',
      { class: 'item-main' },
      h('button', { type: 'button', class: 'item-title', onclick: () => openContest(c.id) }, c.title || '(bez tytułu)'),
      h('span', { class: 'item-labels' }, labelsFor(r)),
      h('div', { class: 'item-meta' }, meta),
    ),
    h(
      'div',
      { class: 'item-side' },
      h('span', { class: `meta-pill due ${dueClass(dl)}`, title: `Koniec: ${fmtDay(c.end, true)}` }, icon('clock', { size: 14 }), rel(dl)),
      h(
        'span',
        { class: 'meta-pill', title: comments ? `Komentarze pod postem (sprawdzone ${fmtDay(comments.at)})` : 'Liczba komentarzy nieznana' },
        icon('comment', { size: 14 }),
        comments ? String(comments.n) : '?',
      ),
      oddsEl(odds),
      star,
    ),
  );
}

function boxEl(title, list, emptyText) {
  const box = h('div', { class: 'box', role: 'list' });
  if (title) box.append(h('div', { class: 'box-header' }, title));
  if (!list.length) box.append(h('div', { class: 'box-empty' }, emptyText));
  else list.forEach((r) => box.append(itemEl(r)));
  return box;
}

function renderTabs(all) {
  const nav = $('#tabs');
  nav.replaceChildren(
    ...TABS.map((t) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tab',
          role: 'tab',
          'aria-selected': ui.tab === t.id ? 'true' : 'false',
          onclick: () => {
            ui.tab = t.id;
            saveUi();
            render();
          },
        },
        icon(t.icon),
        t.label,
        h('span', { class: 'counter' }, String(all.filter((r) => inTab(r, t.id)).length)),
      ),
    ),
  );
  nav.setAttribute('role', 'tablist');
}

let toolbarBuilt = false;
function buildToolbar() {
  if (toolbarBuilt) return;
  toolbarBuilt = true;
  const search = h('input', {
    id: 'q',
    class: 'input',
    type: 'search',
    placeholder: 'Szukaj konkursów…',
    'aria-label': 'Szukaj konkursów',
    value: ui.q,
    oninput: (e) => {
      ui.q = e.target.value;
      renderList();
    },
  });
  const sel = (id, label, options, key) =>
    h(
      'select',
      {
        id,
        class: 'input',
        'aria-label': label,
        onchange: (e) => {
          ui[key] = e.target.value;
          saveUi();
          render();
        },
      },
      options.map(([v, t]) => h('option', { value: v, selected: ui[key] === v }, t)),
    );
  $('#toolbar').replaceChildren(
    h('div', { class: 'search' }, icon('search'), search),
    sel('f-cat', 'Rodzaj nagrody', [['all', 'Wszystkie nagrody'], ...L.KIND_ORDER.map((k) => [k, L.PRIZE_KINDS[k].label])], 'cat'),
    sel('f-sort', 'Sortowanie', [['deadline', 'Sortuj: termin'], ['value', 'Sortuj: wartość nagrody'], ['odds', 'Sortuj: szansa'], ['new', 'Sortuj: najnowsze']], 'sort'),
    h(
      'label',
      { class: 'check', title: 'Pokaż konkursy ukryte przez filtry i pominięte' },
      h('input', {
        id: 'f-hidden',
        type: 'checkbox',
        checked: ui.showHidden,
        onchange: (e) => {
          ui.showHidden = e.target.checked;
          saveUi();
          render();
        },
      }),
      h('span', { id: 'f-hidden-label' }, 'Pokaż ukryte'),
    ),
  );
}

function renderStats(all) {
  const submitted = all.filter((r) => L.DONE.has(r.st)).length;
  const won = all.filter((r) => r.st === 'won').length;
  const lost = all.filter((r) => r.st === 'lost').length;
  const stays = all.filter((r) => inTab(r, 'open', false) && L.flagsOf(r.c).stay).length;
  const valuable = all.filter((r) => inTab(r, 'open', false) && L.isValuable(r.prize)).length;
  const fresh = all.filter((r) => inTab(r, 'open', false) && r.isNew).length;
  const hiddenCount = all.filter((r) => (r.dl === null || r.dl >= 0) && !L.DONE.has(r.st) && (r.hidden || r.st === 'skipped')).length;
  $('#f-hidden-label').textContent = `Pokaż ukryte (${hiddenCount})`;
  const part = (label, value) => h('span', null, label, ' ', h('strong', null, String(value)));
  const stats = [part('Zgłoszone:', submitted), part('Wygrane:', won)];
  if (won + lost > 0) stats.push(part('Skuteczność:', `${Math.round((won / (won + lost)) * 100)}%`));
  stats.push(part('Wyjazdy:', stays));
  stats.push(part(`Wartościowe (od ${L.formatPLN(L.VALUABLE_FROM)}):`, valuable));
  if (fresh) stats.push(part('Nowe:', fresh));
  $('#stats').replaceChildren(...stats);
}

function renderList() {
  const all = rows();
  const list = sortRows(all.filter((r) => inTab(r, ui.tab) && matches(r)));
  const root = $('#list');
  const empty = {
    open: 'Brak otwartych konkursów pasujących do filtrów.',
    todo: 'Kliknij gwiazdkę przy konkursie, żeby dodać go do „Planuję”.',
    submitted: 'Zaznacz pole przy konkursie, gdy wyślesz zgłoszenie.',
    results: 'Gdy poznasz wynik, ustaw w szczegółach status „Wygrane” albo „Przegrane”.',
    closed: 'Brak zakończonych konkursów.',
  }[ui.tab];
  const boxes = [];
  if (catalogError) boxes.push(h('div', { class: 'flash flash-warn' }, catalogError));
  if ((ui.tab === 'open' || ui.tab === 'todo') && ui.cat === 'all' && (ui.sort === 'deadline' || ui.sort === 'odds') && list.length) {
    // Sekcje według rodzaju nagrody: wyjazdy, sprzęt, bony, pozostałe
    for (const kind of L.KIND_ORDER) {
      const part = list.filter((r) => r.prize.kind === kind);
      if (!part.length) continue;
      const valuable = part.filter((r) => L.isValuable(r.prize)).length;
      boxes.push(
        boxEl(
          h(
            'span',
            { class: 'box-title' },
            icon(KIND_ICON[kind]),
            ` ${L.PRIZE_KINDS[kind].label} `,
            h('span', { class: 'counter' }, String(part.length)),
            valuable ? h('span', { class: 'muted box-note' }, ` · wartościowe: ${valuable}`) : null,
          ),
          part,
          '',
        ),
      );
    }
  } else {
    boxes.push(boxEl(h('span', null, `${list.length} ${L.plural(list.length, ['konkurs', 'konkursy', 'konkursów'])}`), list, empty));
  }
  root.replaceChildren(...boxes);
  return all;
}

function renderSyncButton() {
  const btn = $('#btn-sync');
  const cls = { ok: 'ok', busy: 'busy', err: 'err', local: '' }[syncInfo.kind] || '';
  btn.className = `btn btn-sm btn-invisible sync ${cls}`;
  const title = sync ? `${syncInfo.msg}${sync.login ? ` (@${sync.login})` : ''}` : 'Dane tylko na tym urządzeniu – kliknij, żeby włączyć synchronizację';
  btn.title = title;
  btn.replaceChildren(h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'sync-text' }, sync ? syncInfo.msg : 'Lokalnie'));
}

function renderFooter() {
  const f = $('#footer');
  const upd = catalog.updatedAt ? new Date(catalog.updatedAt) : null;
  const parts = [
    h('span', null, 'Lista konkursów: ', upd ? upd.toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' }) : '—', ` (${(catalog.contests || []).length})`),
    h('span', null, 'Źródło: ', extLink('https://www.e-konkursy.info/', 'e-konkursy.info')),
    site.repoUrl ? h('span', null, extLink(site.repoUrl, 'Kod na GitHubie')) : null,
    h('span', null, 'Skróty: ', h('span', { class: 'kbd' }, '/'), ' szukaj, ', h('span', { class: 'kbd' }, 'c'), ' dodaj'),
  ];
  f.replaceChildren(...parts.filter(Boolean));
}

function render() {
  buildToolbar();
  const all = renderList();
  renderTabs(all);
  renderStats(all);
  renderSyncButton();
  renderFooter();
}

// ---------- szczegóły konkursu ----------

function findRow(id) {
  return rows().find((r) => r.c.id === id) || null;
}

function openContest(id) {
  const target = `#c=${encodeURIComponent(id)}`;
  if (location.hash !== target) history.pushState(null, '', target);
  renderContest(id);
}

function closeDialogs() {
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
}

function sidebarSection(title, ...content) {
  return h('div', { class: 'sidebar-section' }, h('div', { class: 'sidebar-title' }, title), h('div', { class: 'sidebar-value' }, ...content));
}

function commentBox(title, body, extra) {
  return h('div', { class: 'comment' }, h('div', { class: 'comment-header' }, h('span', null, title), extra || null), body);
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function renderContest(id) {
  const dlg = $('#dlg-contest');
  const r = findRow(id);
  if (!r) {
    toast('Nie znaleziono konkursu');
    if (dlg.open) dlg.close();
    return;
  }
  openId = id;
  const { c, it, st, dl, odds } = r;
  const f = L.flagsOf(c);
  const today = L.todayISO();

  const badge =
    st === 'won'
      ? h('span', { class: 'state state-badge-won' }, icon('trophy'), 'Wygrane')
      : st === 'lost'
        ? h('span', { class: 'state state-badge-closed' }, icon('lost'), 'Przegrane')
        : st === 'submitted'
          ? h('span', { class: 'state state-badge-done' }, icon('done'), 'Zgłoszone')
          : st === 'skipped'
            ? h('span', { class: 'state state-badge-closed' }, icon('skip'), 'Pominięte')
            : dl !== null && dl < 0
              ? h('span', { class: 'state state-badge-closed' }, icon('closed'), 'Zakończony')
              : h('span', { class: 'state state-badge-open' }, icon('open'), 'Otwarty');

  // --- kolumna główna ---
  const main = h('div', null);
  if (c.task) main.append(commentBox(h('span', null, h('strong', null, 'Zadanie'), ' – opis z e-konkursy.info'), h('div', { class: 'comment-body' }, c.task), extLink(c.src, 'źródło')));
  if (c.prizes) main.append(commentBox(h('strong', null, 'Nagrody'), h('div', { class: 'comment-body' }, c.prizes)));

  const answers = (c.answers || []).filter((a) => typeof a === 'string' && a.trim());
  if (answers.length) {
    const list = h('div', null);
    answers.forEach((a, i) =>
      list.append(
        h(
          'div',
          { class: 'answer' },
          h('div', { class: 'answer-text' }, a),
          h(
            'div',
            { class: 'answer-actions' },
            i === 0 && answers.length > 1 ? h('span', { class: 'label label-draw' }, 'polecana') : null,
            h('button', { type: 'button', class: 'btn btn-sm', onclick: () => copyText(a) }, icon('copy'), 'Kopiuj'),
          ),
        ),
      ),
    );
    main.append(commentBox(h('strong', null, 'Gotowe odpowiedzi'), list, h('span', { class: 'hint' }, 'Podmień [@Znajomy] i dopasuj szczegóły do siebie')));
  }

  const saveAnswer = debounce((v) => setItem(c.id, { answer: v }), 600);
  const myAnswer = h('textarea', { class: 'input', rows: 4, placeholder: 'Twoja odpowiedź – zapisze się automatycznie', oninput: (e) => saveAnswer(e.target.value) }, it.answer || '');
  main.append(
    commentBox(
      h('strong', null, 'Moja odpowiedź'),
      h('div', { class: 'comment-body', style: 'white-space:normal' }, myAnswer),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => copyText(myAnswer.value) }, icon('copy'), 'Kopiuj'),
    ),
  );
  const saveNote = debounce((v) => setItem(c.id, { note: v }), 600);
  main.append(
    commentBox(
      h('strong', null, 'Notatka'),
      h('div', { class: 'comment-body', style: 'white-space:normal' }, h('textarea', { class: 'input', rows: 3, placeholder: 'Np. kogo oznaczyć, gdzie odebrać nagrodę…', oninput: (e) => saveNote(e.target.value) }, it.note || '')),
    ),
  );

  // --- pasek boczny ---
  const side = h('div', null);
  const statusSel = h(
    'select',
    {
      class: 'input',
      'aria-label': 'Status',
      onchange: (e) => {
        setStatus(c, e.target.value);
        renderContest(id);
      },
    },
    Object.entries(L.STATUS_LABELS).map(([v, t]) => h('option', { value: v, selected: st === v }, t)),
  );
  side.append(sidebarSection('Status', statusSel));
  if (L.DONE.has(st)) {
    side.append(
      sidebarSection(
        'Data zgłoszenia',
        h('input', { class: 'input', type: 'date', value: it.at || '', onchange: (e) => setItem(c.id, { at: e.target.value || undefined }) }),
      ),
    );
  }
  side.append(sidebarSection('Termin', h('span', { class: `due ${dueClass(dl)}` }, rel(dl)), h('div', { class: 'hint' }, `do ${fmtDay(c.end, true)}${c.start ? `, od ${fmtDay(c.start, true)}` : ''}`)));
  side.append(
    sidebarSection(
      'Ogłoszenie wyników',
      h('input', {
        class: 'input',
        type: 'date',
        value: L.resultsOf(c, it) || '',
        onchange: (e) => {
          setItem(c.id, { results: e.target.value || undefined });
          renderContest(id);
        },
      }),
      h('div', { class: 'hint' }, L.resultsOf(c, it) ? 'Dostaniesz przypomnienie w dniu wyników.' : 'Bez daty przypomnę 3 dni po końcu konkursu.'),
    ),
  );

  const cm = L.commentsOf(c, it);
  const cmInput = h('input', { class: 'input', type: 'number', min: '0', step: '1', inputmode: 'numeric', value: cm ? String(cm.n) : '', placeholder: 'np. 120', 'aria-label': 'Liczba komentarzy' });
  const saveComments = () => {
    const v = cmInput.value.trim();
    if (v === '') return;
    const n = Math.max(0, Math.round(Number(v)));
    if (!Number.isFinite(n)) return;
    setItem(c.id, { comments: n, commentsAt: today });
    toast('Zapisano liczbę komentarzy');
    renderContest(id);
  };
  cmInput.addEventListener('keydown', (e) => e.key === 'Enter' && saveComments());
  side.append(
    sidebarSection(
      'Komentarze pod postem',
      h('div', { class: 'inline-form' }, cmInput, h('button', { type: 'button', class: 'btn btn-sm', onclick: saveComments }, 'Zapisz')),
      h('div', { class: 'hint' }, cm ? `Sprawdzone ${fmtDay(cm.at)}. ` : 'Nieznana. ', extLink(c.url, 'Otwórz post i policz')),
    ),
  );
  side.append(
    sidebarSection(
      'Liczba nagród',
      h('input', {
        class: 'input',
        type: 'number',
        min: '1',
        step: '1',
        value: String(L.prizesOf(c, it) || ''),
        onchange: (e) => {
          const n = Math.round(Number(e.target.value));
          setItem(c.id, { prizes: n > 0 ? n : undefined });
          renderContest(id);
        },
      }),
    ),
  );
  const pz = r.prize;
  side.append(
    sidebarSection(
      'Nagroda',
      h('div', null, icon(KIND_ICON[pz.kind]), ' ', L.PRIZE_KINDS[pz.kind].label),
      pz.value !== null ? h('div', { style: 'margin-top:4px' }, prizeLabel(pz)) : h('div', { class: 'hint' }, 'Wartość nieznana'),
      pz.estimated ? h('div', { class: 'hint' }, 'Szacunek – w opisie nie ma kwoty.') : null,
    ),
  );
  side.append(sidebarSection('Szansa', oddsEl(odds), h('div', { class: 'hint' }, 'komentarze ÷ nagrody; im mniejsza druga liczba, tym lepiej')));

  const req = [];
  if (f.follow) req.push('obserwowanie profilu');
  if (f.tags) req.push(`oznaczenie ${f.tags} ${L.plural(f.tags, ['osoby', 'osób', 'osób'])}`);
  if (f.fbShare) req.push('udostępnienie na Facebooku');
  if (f.igShare) req.push('udostępnienie na Instagramie');
  if (f.shareOptional && !f.fbShare && !f.igShare) req.push('udostępnienie – nieobowiązkowe');
  if (f.purchase) req.push('zakup / paragon');
  if (f.app) req.push('aplikacja');
  if (f.content) req.push('zdjęcie / film / grafika');
  side.append(sidebarSection('Wymagania (automatycznie)', req.length ? h('ul', { style: 'margin:0;padding-left:18px' }, req.map((x) => h('li', null, x))) : h('span', { class: 'muted' }, 'tylko komentarz'), h('div', { class: 'hint' }, 'Zawsze sprawdź regulamin pod postem.')));
  if (c.org || c.platform) side.append(sidebarSection('Organizator', c.org || '—', c.platform ? h('div', { class: 'hint' }, PLATFORM[c.platform] || c.platform) : null));
  side.append(sidebarSection('Linki', h('div', { style: 'display:grid;gap:4px' }, extLink(c.url, 'Otwórz post konkursowy'), extLink(c.src, 'Opis na e-konkursy.info'))));

  const actions = h('div', { class: 'btn-group' });
  if (st !== 'skipped' && !L.DONE.has(st)) {
    actions.append(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm',
          onclick: () => {
            setStatus(c, 'skipped');
            toast('Pominięto – konkurs jest teraz ukryty');
            dlg.close();
          },
        },
        icon('skip'),
        'Pomiń',
      ),
    );
  }
  if (c.manual) {
    actions.append(h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openAdd(c.id) }, icon('pencil'), 'Edytuj'));
    actions.append(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-danger',
          onclick: () => {
            if (!confirm('Usunąć ten konkurs dodany ręcznie?')) return;
            state.manual[c.id] = { ...state.manual[c.id], deleted: true, t: Date.now() };
            commit();
            dlg.close();
            toast('Usunięto');
          },
        },
        icon('trash'),
        'Usuń',
      ),
    );
  }
  if (actions.childElementCount) side.append(sidebarSection('Akcje', actions));

  const body = h(
    'div',
    { class: 'dlg-body' },
    h('h1', { class: 'issue-title', id: 'dlg-contest-title' }, c.title || '(bez tytułu)'),
    h(
      'div',
      { class: 'issue-sub' },
      badge,
      h('span', null, `${rel(dl)} · do ${fmtDay(c.end, true)}`),
      h('span', { class: 'item-labels' }, labelsFor({ ...r, hidden: '' })),
    ),
    h('div', { class: 'layout' }, main, side),
  );
  const head = h(
    'div',
    { class: 'dlg-header' },
    h('h2', null, 'Konkurs'),
    !L.DONE.has(st)
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-primary',
            onclick: () => {
              setStatus(c, 'submitted');
              toast('Oznaczono jako zgłoszone ✓');
              renderContest(id);
            },
          },
          icon('done'),
          'Zgłoszone',
        )
      : null,
    h('button', { type: 'button', class: 'btn btn-sm btn-invisible btn-icon', 'aria-label': 'Zamknij', onclick: () => dlg.close() }, icon('x')),
  );
  dlg.replaceChildren(head, body);
  if (!dlg.open) dlg.showModal();
}

// ---------- ustawienia ----------

function settingsSection(title, desc, ...content) {
  return h('section', { class: 'settings-section' }, h('h3', null, title), desc ? h('p', null, desc) : null, ...content);
}

function openSettings(focus) {
  renderSettings();
  const dlg = $('#dlg-settings');
  if (!dlg.open) dlg.showModal();
  if (focus) {
    const el = dlg.querySelector(focus);
    if (el) el.scrollIntoView({ block: 'start' });
  }
}

function renderSettings() {
  const dlg = $('#dlg-settings');
  const s = L.settingsOf(state);

  // Synchronizacja
  const tokenForm = (change) => {
    const tokenInput = h('input', { id: 'set-token', class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…' });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, change ? 'Zapisz' : 'Połącz');
    return h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          btn.textContent = 'Łączę…';
          try {
            const login = await connect(tokenInput.value);
            toast(`Połączono jako @${login}`);
          } catch (err) {
            toast(err.status === 401 ? 'Nieprawidłowy token' : err.status === 403 || err.status === 404 ? 'Token nie ma uprawnienia do gistów' : 'Nie udało się połączyć');
          }
          renderSettings();
        },
      },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'set-token' }, change ? 'Nowy token GitHub' : 'Token GitHub'),
        h('div', { class: 'inline-form' }, tokenInput, btn),
        h(
          'ol',
          { class: 'hint steps' },
          h('li', null, extLink(L.tokenTemplateUrl(), 'Otwórz formularz tokenu'), ' – uprawnienia Gists i Actions są już zaznaczone.'),
          h('li', null, 'W „Repository access” wybierz ', h('strong', null, 'Only select repositories'), ` → ${site.repo}.`),
          h('li', null, 'Kliknij „Generate token”, skopiuj go i wklej tutaj – na każdym urządzeniu.'),
        ),
        h('div', { class: 'hint' }, 'Token zostaje wyłącznie w tej przeglądarce. Gisty służą do synchronizacji, a Actions do przycisku „Odśwież”.'),
      ),
    );
  };
  const syncSec = [];
  if (sync) {
    syncSec.push(
      h(
        'div',
        { class: `flash ${syncInfo.kind === 'err' ? 'flash-warn' : 'flash-ok'}` },
        h('strong', null, syncInfo.kind === 'err' ? syncInfo.msg : `Połączono jako @${sync.login}`),
        h('div', { class: 'hint' }, 'Stan (statusy, notatki, ustawienia) jest w Twoim sekretnym giście: ', extLink(`https://gist.github.com/${sync.login}/${sync.gistId}`, 'otwórz gist')),
        h('div', { class: 'hint' }, 'Identyfikator gista do sekretu ', h('code', null, 'STATE_GIST_ID'), ': ', h('code', null, sync.gistId)),
      ),
      h(
        'div',
        { class: 'btn-group' },
        h('button', { type: 'button', class: 'btn', onclick: () => syncNow().then(() => renderSettings()) }, icon('refresh'), 'Synchronizuj teraz'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger',
            onclick: () => {
              disconnect();
              renderSettings();
              toast('Rozłączono – dane zostają na tym urządzeniu');
            },
          },
          'Rozłącz',
        ),
      ),
      h('details', { style: 'margin-top:12px' }, h('summary', { class: 'hint' }, 'Zmień token (np. gdy „Odśwież” nie może uruchomić robota)'), h('div', { style: 'margin-top:8px' }, tokenForm(true))),
    );
  } else {
    syncSec.push(tokenForm(false));
  }

  const fileInput = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: 'display:none',
    onchange: async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const obj = JSON.parse(await file.text());
        state = L.mergeStates(state, obj && obj.state ? obj.state : obj);
        commit();
        toast('Wczytano sesję z pliku');
        renderSettings();
      } catch {
        toast('To nie jest plik sesji Konkursów');
      }
      e.target.value = '';
    },
  });

  // Powiadomienia
  const n = s.ntfy;
  const topicInput = h('input', {
    id: 'set-topic',
    class: 'input mono',
    value: n.topic,
    placeholder: 'kliknij ↻, żeby wylosować',
    spellcheck: 'false',
    onchange: (e) => setSettings((x) => (x.ntfy.topic = e.target.value.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64))),
  });
  const dayBox = (d, label) =>
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: n.days.includes(d),
        onchange: (e) =>
          setSettings((x) => {
            const set = new Set(x.ntfy.days);
            if (e.target.checked) set.add(d);
            else set.delete(d);
            x.ntfy.days = [...set].sort((a, b) => b - a);
          }),
      }),
      label,
    );
  const ntfyBox = (key, label) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: n[key], onchange: (e) => setSettings((x) => (x.ntfy[key] = e.target.checked)) }), label);

  const hideBox = (key, label) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.hide[key], onchange: (e) => setSettings((x) => (x.hide[key] = e.target.checked)) }), label);

  const theme = lsGet(K.theme, 'auto') || 'auto';

  const body = h(
    'div',
    { class: 'dlg-body' },
    settingsSection(
      'Synchronizacja i sesja',
      'Połącz konto GitHub, żeby mieć te same statusy, notatki i ustawienia na telefonie i komputerze. Bez tego dane zostają tylko w tej przeglądarce.',
      ...syncSec,
      h(
        'div',
        { class: 'btn-group', style: 'margin-top:12px' },
        h('button', { type: 'button', class: 'btn', onclick: exportSession }, icon('download'), 'Eksportuj sesję do pliku'),
        h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, icon('upload'), 'Wczytaj sesję z pliku'),
        fileInput,
      ),
    ),
    h(
      'section',
      { class: 'settings-section', id: 'set-ntfy' },
      h('h3', null, 'Powiadomienia na telefon (ntfy)'),
      h('p', null, 'Robot sprawdza listę codziennie rano i wysyła jedno zbiorcze powiadomienie.'),
      !sync ? h('div', { class: 'flash flash-warn' }, 'Robot czyta te ustawienia z synchronizacji. Połącz synchronizację powyżej – inaczej zmiany zostaną tylko na tym urządzeniu.') : null,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: n.enabled, onchange: (e) => setSettings((x) => (x.ntfy.enabled = e.target.checked)) }), h('strong', null, 'Wysyłaj powiadomienia')),
      h(
        'div',
        { class: 'field', style: 'margin-top:12px' },
        h('label', { for: 'set-topic' }, 'Nazwa kanału ntfy'),
        h(
          'div',
          { class: 'inline-form' },
          topicInput,
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              title: 'Wylosuj nową nazwę',
              onclick: () => {
                setSettings((x) => (x.ntfy.topic = L.randomTopic()));
                renderSettings();
              },
            },
            icon('refresh'),
          ),
          h('button', { type: 'button', class: 'btn', title: 'Kopiuj', onclick: () => copyText(L.settingsOf(state).ntfy.topic) }, icon('copy')),
        ),
        h('div', { class: 'hint' }, 'Nazwa działa jak hasło – kto ją zna, widzi powiadomienia. Zainstaluj aplikację ntfy (Android/iPhone), kliknij + i wpisz tę nazwę.'),
      ),
      h('div', { class: 'label-text' }, 'Przypominaj o końcu konkursu'),
      h('div', { class: 'row-fields' }, dayBox(3, '3 dni przed'), dayBox(2, '2 dni przed'), dayBox(1, 'dzień przed'), dayBox(0, 'w ostatnim dniu')),
      h('div', { class: 'label-text', style: 'margin-top:12px' }, 'O których konkursach'),
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'radio', name: 'scope', checked: n.scope === 'all', onchange: () => setSettings((x) => (x.ntfy.scope = 'all')) }),
        h(
          'span',
          null,
          'Wszystkie widoczne, ze szansą lepszą niż 1:',
          h('input', {
            class: 'input mono',
            type: 'number',
            min: '1',
            style: 'width:90px;min-height:24px;padding:0 6px;margin-left:4px',
            value: String(n.maxOdds),
            onchange: (e) => setSettings((x) => (x.ntfy.maxOdds = Math.max(1, Math.round(Number(e.target.value) || 150)))),
          }),
          ' (oraz oznaczone „Planuję”)',
        ),
      ),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'scope', checked: n.scope === 'todo', onchange: () => setSettings((x) => (x.ntfy.scope = 'todo')) }), 'Tylko oznaczone „Planuję”'),
      h(
        'div',
        { style: 'margin-top:8px' },
        ntfyBox('newStays', 'Nowe konkursy z noclegiem lub wyjazdem'),
        ntfyBox('newValuable', `Nowe wartościowe nagrody (od ${L.formatPLN(L.VALUABLE_FROM)})`),
        ntfyBox('results', 'Dzień ogłoszenia wyników zgłoszonych konkursów'),
      ),
      h(
        'details',
        { style: 'margin:8px 0' },
        h('summary', { class: 'hint' }, 'Własny serwer ntfy'),
        h('input', {
          class: 'input mono',
          value: n.server,
          style: 'margin-top:8px',
          onchange: (e) => setSettings((x) => (/^https?:\/\//.test(e.target.value.trim()) ? (x.ntfy.server = e.target.value.trim()) : null)),
        }),
      ),
      h('button', { type: 'button', class: 'btn', onclick: sendTest }, icon('bell'), 'Wyślij powiadomienie testowe'),
    ),
    settingsSection(
      'Filtry',
      'Ukryte konkursy zobaczysz po zaznaczeniu „Pokaż ukryte” nad listą.',
      hideBox('party', 'Ukryj imprezy (Sylwester, bale, koncerty)'),
      hideBox('fbShare', 'Ukryj wymagające udostępnienia na Facebooku'),
      hideBox('igShare', 'Ukryj wymagające udostępnienia na Instagramie'),
      hideBox('purchase', 'Ukryj wymagające zakupu lub paragonu'),
      hideBox('app', 'Ukryj wymagające aplikacji'),
      hideBox('content', 'Ukryj wymagające zdjęcia lub filmu (poza noclegami i wyjazdami)'),
      hideBox('creative', 'Ukryj wymagające pracy twórczej (eseje, wiersze, opowiadania, nagrania, projekty, konkursy szkolne)'),
    ),
    settingsSection(
      'Wygląd',
      null,
      h(
        'select',
        {
          class: 'input',
          style: 'max-width:240px',
          'aria-label': 'Motyw',
          onchange: (e) => {
            const v = e.target.value;
            lsSet(K.theme, v === 'auto' ? null : v);
            if (v === 'auto') delete document.documentElement.dataset.theme;
            else document.documentElement.dataset.theme = v;
          },
        },
        h('option', { value: 'auto', selected: theme === 'auto' }, 'Motyw: jak w systemie'),
        h('option', { value: 'light', selected: theme === 'light' }, 'Motyw: jasny'),
        h('option', { value: 'dark', selected: theme === 'dark' }, 'Motyw: ciemny'),
      ),
    ),
    settingsSection(
      'To urządzenie',
      'Usuwa statusy, notatki i token z tej przeglądarki. Dane w giście zostają.',
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-danger',
          onclick: () => {
            if (!confirm('Usunąć dane aplikacji z tej przeglądarki?')) return;
            lsSet(K.state, null);
            lsSet(K.sync, null);
            state = L.emptyState();
            sync = null;
            setSync('local', 'Tylko to urządzenie');
            render();
            renderSettings();
            toast('Usunięto dane z tego urządzenia');
          },
        },
        icon('trash'),
        'Usuń dane z tego urządzenia',
      ),
    ),
  );
  const head = h(
    'div',
    { class: 'dlg-header' },
    h('h2', { id: 'dlg-settings-title' }, 'Ustawienia'),
    h('button', { type: 'button', class: 'btn btn-sm btn-invisible btn-icon', 'aria-label': 'Zamknij', onclick: () => dlg.close() }, icon('x')),
  );
  const scroll = dlg.querySelector('.dlg-body') ? dlg.querySelector('.dlg-body').scrollTop : 0;
  dlg.replaceChildren(head, body);
  body.scrollTop = scroll;
}

async function sendTest() {
  const n = L.settingsOf(state).ntfy;
  if (!n.topic) {
    toast('Najpierw ustaw nazwę kanału');
    return;
  }
  try {
    // Bez nagłówka Content-Type – prosty request bez preflightu CORS.
    const res = await fetch(n.server.replace(/\/+$/, '') + '/', {
      method: 'POST',
      body: JSON.stringify({ topic: n.topic, title: 'Konkursy: test', message: 'Działa! Tu będą przypomnienia o kończących się konkursach.', tags: ['tada'], click: site.appUrl }),
    });
    toast(res.ok ? 'Wysłano – sprawdź telefon' : `ntfy odpowiedział: ${res.status}`);
  } catch {
    toast('Nie udało się wysłać (brak sieci?)');
  }
}

function exportSession() {
  const blob = new Blob([JSON.stringify({ app: 'konkursy', exportedAt: new Date().toISOString(), state }, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `konkursy-sesja-${L.todayISO()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- dodawanie / edycja ----------

function openAdd(editId) {
  const dlg = $('#dlg-add');
  const old = editId ? state.manual[editId] : null;
  const today = L.todayISO();
  const f = (id, label, input, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const title = h('input', { id: 'a-title', class: 'input', required: true, value: old ? old.title || '' : '', placeholder: 'Np. Wygraj weekend w górach' });
  const url = h('input', { id: 'a-url', class: 'input', type: 'url', required: true, value: old ? old.url || '' : '', placeholder: 'https://www.facebook.com/…' });
  const end = h('input', { id: 'a-end', class: 'input', type: 'date', required: true, value: old ? old.end || '' : '', min: old ? undefined : today });
  const prizes = h('textarea', { id: 'a-prizes', class: 'input', rows: 2, placeholder: 'Np. 3x voucher na pobyt' }, old ? old.prizes || '' : '');
  const prizeCount = h('input', { id: 'a-pc', class: 'input', type: 'number', min: '1', value: old && old.prizeCount ? String(old.prizeCount) : '' });
  const comments = h('input', { id: 'a-cm', class: 'input', type: 'number', min: '0', value: old && old.comments !== undefined ? String(old.comments) : '' });
  const task = h('textarea', { id: 'a-task', class: 'input', rows: 3, placeholder: 'Co trzeba zrobić' }, old ? old.task || '' : '');
  const stay = h('input', { type: 'checkbox', checked: Boolean(old && old.flags && old.flags.stay) });

  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        if (!safeUrl(url.value.trim())) {
          toast('Podaj pełny link zaczynający się od https://');
          return;
        }
        const id = old ? old.id : `m:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const platform = L.platformOf(url.value.trim());
        const { flags, judging } = L.classify({ title: title.value, task: task.value, prizes: prizes.value, platform });
        flags.stay = stay.checked;
        const pc = Math.round(Number(prizeCount.value));
        const cm = comments.value.trim() === '' ? null : Math.round(Number(comments.value));
        const contest = L.cleanContest({
          id,
          title: title.value.trim(),
          url: url.value.trim(),
          end: end.value,
          prizes: prizes.value.trim(),
          prizeCount: pc > 0 ? pc : L.parsePrizeCount(prizes.value) || 1,
          comments: cm !== null && cm >= 0 ? cm : undefined,
          commentsAt: cm !== null && cm >= 0 ? today : undefined,
          task: task.value.trim(),
          platform,
          judging,
          flags,
          firstSeen: old ? old.firstSeen || today : today,
          t: Date.now(),
        });
        state.manual[id] = contest;
        commit();
        dlg.close();
        toast(old ? 'Zapisano zmiany' : 'Dodano konkurs');
        openContest(id);
      },
    },
    h(
      'div',
      { class: 'dlg-body' },
      f('a-title', 'Tytuł', title),
      f('a-url', 'Link do posta konkursowego', url),
      h('div', { class: 'row-fields' }, f('a-end', 'Koniec zgłoszeń', end), f('a-pc', 'Liczba nagród', prizeCount), f('a-cm', 'Komentarze teraz', comments)),
      f('a-prizes', 'Nagrody', prizes),
      f('a-task', 'Zadanie', task),
      h('label', { class: 'check' }, stay, 'Nocleg, pobyt lub wyjazd'),
    ),
    h(
      'div',
      { class: 'dlg-footer' },
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Anuluj'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, old ? 'Zapisz' : 'Dodaj konkurs'),
    ),
  );
  dlg.replaceChildren(
    h(
      'div',
      { class: 'dlg-header' },
      h('h2', { id: 'dlg-add-title' }, old ? 'Edytuj konkurs' : 'Nowy konkurs'),
      h('button', { type: 'button', class: 'btn btn-sm btn-invisible btn-icon', 'aria-label': 'Zamknij', onclick: () => dlg.close() }, icon('x')),
    ),
    form,
  );
  if ($('#dlg-contest').open) $('#dlg-contest').close();
  dlg.showModal();
  title.focus();
}

// ---------- start ----------

function setCatalog(data, { cache = true } = {}) {
  catalog = { ...data, contests: Array.isArray(data && data.contests) ? data.contests : [] };
  catalogError = '';
  if (cache) lsSet(K.catalog, catalog);
}

async function loadCatalog() {
  const cached = lsGet(K.catalog);
  try {
    const res = await fetch('data/contests.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    // Po odświeżeniu GitHub Pages bywa kilka minut w tyle – wybierz nowszą z dwóch list.
    if (cached && cached.updatedAt && data.updatedAt && cached.updatedAt > data.updatedAt) setCatalog(cached, { cache: false });
    else setCatalog(data);
  } catch {
    if (cached && Array.isArray(cached.contests)) {
      setCatalog(cached, { cache: false });
      catalogError = 'Brak połączenia – pokazuję ostatnio pobraną listę.';
    } else {
      catalogError = 'Nie udało się wczytać listy konkursów – pokazuję tylko Twoje zapisane konkursy.';
    }
  }
}

function routeFromHash() {
  const m = location.hash.match(/^#c=(.+)$/);
  if (m) renderContest(decodeURIComponent(m[1]));
  else if ($('#dlg-contest').open) $('#dlg-contest').close();
}

function setupChrome() {
  $('#brand-owner').textContent = site.owner;
  $('#btn-settings').replaceChildren(icon('sliders'));
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-add').replaceChildren(icon('plus'), h('span', { class: 'btn-add-text' }, 'Dodaj konkurs'));
  $('#btn-add').addEventListener('click', () => openAdd());
  $('#btn-refresh').addEventListener('click', refreshList);
  renderRefreshButton();
  $('#btn-sync').addEventListener('click', () => {
    if (sync && syncInfo.kind !== 'err') syncNow();
    else openSettings();
  });
  $('#dlg-contest').addEventListener('close', () => {
    openId = null;
    if (location.hash.startsWith('#c=')) history.replaceState(null, '', location.pathname + location.search);
  });
  window.addEventListener('hashchange', routeFromHash);
  window.addEventListener('popstate', routeFromHash);
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
    if (e.key === '/') {
      e.preventDefault();
      $('#q').focus();
    } else if (e.key === 'c') {
      e.preventDefault();
      openAdd();
    } else if (e.key === 'r') {
      e.preventDefault();
      refreshList();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sync && Date.now() - lastPull > 30000) syncNow();
  });
  window.addEventListener('online', () => sync && syncNow());
  setInterval(() => {
    if (document.visibilityState === 'visible' && sync) syncNow();
  }, 5 * 60 * 1000);
}

async function boot() {
  setupChrome();
  const cached = lsGet(K.catalog);
  if (cached && Array.isArray(cached.contests)) setCatalog(cached, { cache: false });
  render();
  await loadCatalog();
  render();
  routeFromHash();
  if (sync) syncNow();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
