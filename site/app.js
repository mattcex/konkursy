// Lootsy – aplikacja (GitHub Pages i Android). Bez zależności i bez kroku budowania.
import * as L from './logic.js';
import { translator, detectLang } from './i18n.js';

// Klucze pamięci bez zmian względem wersji „Konkursy”, żeby nie zgubić zapisanych danych.
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
// Kategorie listy: widoki, platformy i rodzaje nagród (sekcje).
const VIEW_CATS = ['all', 'mine', 'purchase'];
const PLATFORM_CATS = ['instagram', 'facebook'];
let ui = { tab: 'open', q: '', cat: 'all', sort: 'deadline', showHidden: false, purchaseOpen: false, ...(lsGet(K.ui) || {}) };
if (ui.cat === 'stay') ui.cat = 'trip'; // starsza wersja ustawień
if (![...VIEW_CATS, ...PLATFORM_CATS, ...L.KIND_ORDER].includes(ui.cat)) ui.cat = 'all';
if (!['deadline', 'odds', 'value', 'new'].includes(ui.sort)) ui.sort = 'deadline';
let sync = lsGet(K.sync);
let syncInfo = { kind: sync ? 'busy' : 'local', key: sync ? 'sync.connecting' : 'sync.local' };
let openId = null;

// ---------- język ----------

let tr = translator('pl');
const t = (key, vars) => tr.t(key, vars);
const tn = (key, n, vars) => tr.tn(key, n, vars);

function resolveLang() {
  const pref = L.settingsOf(state).lang;
  return pref === 'auto' ? detectLang(navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]) : pref;
}

/** Ustawia język interfejsu; zwraca true, gdy się zmienił. */
function applyLang() {
  const code = resolveLang();
  const changed = code !== tr.lang;
  tr = translator(code);
  document.documentElement.lang = code;
  return changed;
}

const site = (() => {
  const host = location.hostname;
  const appUrl = location.origin + location.pathname.replace(/index\.html$/, '');
  if (host.endsWith('.github.io')) {
    const owner = host.split('.')[0];
    const repo = location.pathname.split('/').filter(Boolean)[0] || host;
    const repoUrl = `https://github.com/${owner}/${repo}`;
    return { owner, repo, repoUrl, appUrl, apkUrl: `${repoUrl}/releases/latest/download/lootsy.apk` };
  }
  return { owner: 'lokalnie', repo: 'konkursy', repoUrl: '', appUrl, apkUrl: '' };
})();

// W aplikacji na Androida nie pokazujemy linku do pobrania APK.
const inAndroidApp = (() => {
  try {
    if (document.referrer.startsWith('android-app://') || new URLSearchParams(location.search).get('source') === 'android') {
      sessionStorage.setItem('lootsy.android', '1');
    }
    return sessionStorage.getItem('lootsy.android') === '1';
  } catch {
    return false;
  }
})();

function saveLocal() {
  lsSet(K.state, state);
}
function saveUi() {
  lsSet(K.ui, { tab: ui.tab, cat: ui.cat, sort: ui.sort, showHidden: ui.showHidden, purchaseOpen: ui.purchaseOpen });
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
  if (applyLang()) rerenderAll();
}

// ---------- synchronizacja (prywatny gist) ----------

let syncTimer = null;
let syncing = false;
let syncAgain = false;
let lastPull = 0;

function setSync(kind, key) {
  syncInfo = { kind, key };
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
  if (!token) throw new Error(t('sync.pasteToken'));
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
      body: { description: t('sync.gistDescription'), public: false, files: { [L.STATE_FILE]: { content: JSON.stringify(state, null, 1) } } },
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
  setSync('local', 'sync.local');
}

/** Pobiera stan z gista, łączy z lokalnym i zapisuje wynik w obu miejscach. */
async function syncNow() {
  if (!sync) return;
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  setSync('busy', 'sync.syncing');
  try {
    const remote = await readGistState(sync.gistId);
    const merged = L.mergeStates(state, remote);
    const localChanged = !L.sameState(merged, state);
    state = merged;
    saveLocal();
    if (localChanged) {
      if (applyLang()) rerenderAll();
      else {
        render();
        if (openId && $('#dlg-contest').open) renderContest(openId);
      }
    }
    if (!L.sameState(merged, remote)) {
      await gh(`/gists/${encodeURIComponent(sync.gistId)}`, {
        method: 'PATCH',
        body: { files: { [L.STATE_FILE]: { content: JSON.stringify(state, null, 1) } } },
      });
    }
    lastPull = Date.now();
    setSync('ok', 'sync.ok');
  } catch (e) {
    if (e.status === 401) setSync('err', 'sync.err401');
    else if (e.status === 404) setSync('err', 'sync.err404');
    else if (e.status === 403) setSync('err', 'sync.err403');
    else setSync('err', 'sync.errNet');
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
let refreshing = null; // klucz tekstu postępu albo null

function renderRefreshButton() {
  const btn = $('#btn-refresh');
  if (!btn) return;
  btn.disabled = Boolean(refreshing);
  btn.title = t('refresh.title');
  btn.replaceChildren(icon('refresh', { cls: refreshing ? 'spin' : '' }), h('span', { class: 'refresh-text' }, t(refreshing || 'refresh.btn')));
}

function setRefreshing(key) {
  refreshing = key;
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
  if (!run) throw new Error(t('refresh.noRun'));
  const started = Date.now();
  while (run.status !== 'completed') {
    if (Date.now() - started > 8 * 60 * 1000) throw new Error(t('refresh.tooLong'));
    setRefreshing(run.status === 'in_progress' ? 'refresh.running' : 'refresh.queued');
    await sleep(5000);
    run = await gh(`/repos/${owner}/${repo}/actions/runs/${run.id}`);
  }
  if (run.conclusion !== 'success') throw new Error(t('refresh.failed', { c: run.conclusion }));
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
  setRefreshing(robot ? 'refresh.starting' : 'refresh.reloading');
  try {
    if (robot) {
      await runRobot();
      setRefreshing('refresh.loading');
      await loadCatalogFromRepo().catch(() => loadCatalog());
    } else {
      await loadCatalog();
    }
    render();
    const added = (catalog.contests || []).filter((c) => !before.has(c.id)).length;
    toast(added ? t('refresh.added', { n: added }) : robot ? t('refresh.none') : t('refresh.reloaded'));
    if (!robot && site.repoUrl) setTimeout(() => toast(t('refresh.hintToken')), 2500);
  } catch (e) {
    if (e.status === 401) toast(t('refresh.tokenExpired'));
    else if (e.status === 403 || e.status === 404) {
      toast(t('refresh.noPermission'));
      openSettings();
    } else toast(e.message || t('refresh.error'));
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
  download: '<path d="M8 2.75v7.5M4.75 7.25L8 10.5l3.25-3.25M2.75 13.25h10.5"/>',
  upload: '<path d="M8 10.5V3M4.75 6.25L8 3l3.25 3.25M2.75 13.25h10.5"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.75h5.8l.6-8.75"/>',
  pencil: '<path d="M11 2.75l2.25 2.25-7.5 7.5H3.5v-2.25z"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.46-3.54M13.25 2.5v3h-3"/>',
  device: '<rect x="2.75" y="3" width="10.5" height="7.25" rx="1"/><path d="M1.25 12.75h13.5"/>',
  gift: '<rect x="2.5" y="6.5" width="11" height="7" rx="1"/><path d="M1.75 4h12.5v2.5H1.75zM8 4v9.5M8 4C7 1.75 4.5 1.75 4.75 3.5M8 4c1-2.25 3.5-2.25 3.25-.5"/>',
  gem: '<path d="M4.5 2.75h7L14 6 8 13.5 2 6z"/><path d="M2 6h12M6.25 2.75L5.5 6 8 13.5 10.5 6l-.75-3.25"/>',
  box: '<path d="M2.5 5L8 2.5 13.5 5v6.5L8 14l-5.5-2.5z"/><path d="M2.5 5L8 7.5 13.5 5M8 7.5V14"/>',
  sparkle: '<path d="M8 1.75l1.4 3.85L13.25 7 9.4 8.4 8 12.25 6.6 8.4 2.75 7 6.6 5.6z"/>',
  heart: '<path d="M8 13.25S2.75 10.15 2.75 6.35A2.85 2.85 0 0 1 8 4.4a2.85 2.85 0 0 1 5.25 1.95c0 3.8-5.25 6.9-5.25 6.9z"/>',
  cart: '<path d="M1.75 2.5h1.7l1.55 7.25h7.25l1.25-5.25H4.05"/><circle cx="6" cy="12.75" r="1"/><circle cx="11.5" cy="12.75" r="1"/>',
  chevron: '<path d="M6 3.75L10.25 8 6 12.25"/>',
  android: '<path d="M4.25 6.5h7.5v5.25a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1zM4.25 6a3.75 3.75 0 0 1 7.5 0M5.5 2.5l1 1.5M10.5 2.5l-1 1.5"/><circle cx="6.5" cy="4.9" r=".4" fill="currentColor"/><circle cx="9.5" cy="4.9" r=".4" fill="currentColor"/>',
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
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
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
  toast(t('toast.copied'));
}

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

function extLink(url, label, cls = '') {
  const u = safeUrl(url);
  if (!u) return null;
  return h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', class: cls }, label, ' ', icon('external', { size: 12 }));
}

// ---------- formatowanie ----------

function fmtDay(iso, withYear = false) {
  if (!L.isISODate(iso)) return '—';
  const [y, m, d] = iso.split('-');
  const cur = L.todayISO().slice(0, 4);
  const months = t('months');
  return `${+d} ${months[+m - 1]}${withYear || y !== cur ? ' ' + y : ''}`;
}

function rel(dl) {
  if (dl === null) return t('rel.none');
  if (dl === 0) return t('rel.today');
  if (dl === 1) return t('rel.tomorrow');
  if (dl > 1) return tn('rel.in', dl);
  if (dl === -1) return t('rel.yesterday');
  return tn('rel.ago', -dl);
}

function dueClass(dl) {
  if (dl === null) return '';
  if (dl < 0) return 'due-past';
  if (dl === 0) return 'due-today';
  if (dl <= 2) return 'due-soon';
  if (dl <= 7) return 'due-week';
  return '';
}

function oddsEl(odds, early = false) {
  if (!odds) return h('span', { class: 'odds odds-bad', title: t('odds.unknown') }, '1:?');
  // Komentarze policzone w dniu publikacji: szansa jeszcze spadnie, więc bez zielonego koloru.
  if (early) return h('span', { class: 'odds odds-early', title: t('odds.early') }, `1:${odds}`);
  const cls = odds <= 30 ? 'odds-good' : odds <= 100 ? 'odds-ok' : 'odds-bad';
  return h('span', { class: `odds ${cls}`, title: t('odds.title') }, `1:${odds}`);
}

const platformName = (p) => ({ facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', x: 'X' })[p] || (p === 'www' ? t('platform.www') : null);
const JUDGING_CLASS = { jury: 'label-jury', losowanie: 'label-draw', reakcje: 'label-warn' };

// ---------- widok listy ----------

function rows() {
  const today = L.todayISO();
  const s = L.settingsOf(state);
  return L.allContests(catalog, state).map((c) => {
    const it = L.itemOf(state, c.id);
    const interests = L.interestsOf(c, it, s.interests.list);
    return {
      c,
      it,
      st: it.s || '',
      dl: L.daysLeft(c, today),
      odds: L.oddsOf(c, it),
      early: L.earlyCount(c, it),
      comments: L.commentsOf(c, it),
      interests,
      purchase: L.needsPurchase(c),
      hidden: L.hiddenReason(c, s.hide),
      prize: L.prizeInfo(c),
      isNew: !c.manual && L.isISODate(c.firstSeen) && (!catalog.since || c.firstSeen > catalog.since) && L.diffDays(c.firstSeen, today) <= 1,
    };
  });
}

const TABS = [
  { id: 'open', icon: 'open' },
  { id: 'todo', icon: 'star' },
  { id: 'submitted', icon: 'done' },
  { id: 'results', icon: 'trophy' },
  { id: 'closed', icon: 'closed' },
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
  if (ui.cat === 'mine') {
    if (!r.interests.length || r.purchase) return false;
  } else if (ui.cat === 'purchase') {
    if (!r.purchase) return false;
  } else if (PLATFORM_CATS.includes(ui.cat)) {
    if (r.c.platform !== ui.cat) return false;
  } else if (ui.cat !== 'all' && (r.purchase || r.prize.kind !== ui.cat)) return false;
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
  const text = `${p.estimated ? '~' : ''}${tr.money(p.value)}`;
  const title = p.estimated ? t('label.valueEst') : t('label.value');
  if (p.tier === 'top') return h('span', { class: 'label label-value-top', title }, icon('gem', { size: 12 }), text);
  if (p.tier === 'high') return h('span', { class: 'label label-value', title }, icon('gem', { size: 12 }), text);
  return h('span', { class: 'label', title }, text);
}

function labelsFor(r) {
  const { c, prize } = r;
  const f = L.flagsOf(c);
  const out = [];
  if (r.isNew) out.push(h('span', { class: 'label label-new', title: t('label.newTitle') }, icon('sparkle', { size: 12 }), t('label.new')));
  for (const id of r.interests) out.push(h('span', { class: 'label label-interest', title: t('label.interestTitle') }, icon('heart', { size: 12 }), t(`interest.${id}`)));
  const pl = prizeLabel(prize);
  if (pl) out.push(pl);
  if (f.stay) out.push(h('span', { class: 'label label-stay', title: t('label.tripTitle') }, icon('bed', { size: 12 }), t('label.trip')));
  else if (prize.kind === 'tech') out.push(h('span', { class: 'label label-tech', title: t('label.techTitle') }, icon('device', { size: 12 }), t('label.tech')));
  else if (prize.kind === 'voucher') out.push(h('span', { class: 'label', title: t('label.voucherTitle') }, icon('gift', { size: 12 }), t('label.voucher')));
  if (JUDGING_CLASS[c.judging]) out.push(h('span', { class: `label ${JUDGING_CLASS[c.judging]}`, title: t(`judging.${c.judging}Title`) }, t(`judging.${c.judging}`)));
  if (c.location) out.push(h('span', { class: 'label label-local', title: t('label.local') }, c.location));
  if (f.fbShare) out.push(h('span', { class: 'label label-danger', title: t('label.fbShareTitle') }, t('label.fbShare')));
  if (f.igShare) out.push(h('span', { class: 'label label-warn', title: t('label.igShareTitle') }, t('label.igShare')));
  if (f.purchase) out.push(h('span', { class: 'label label-purchase', title: t('label.purchaseTitle') }, icon('cart', { size: 12 }), t('label.purchase')));
  if (f.app) out.push(h('span', { class: 'label label-purchase', title: t('label.appTitle') }, t('label.app')));
  if (c.endGuess) out.push(h('span', { class: 'label label-warn', title: t('label.endGuessTitle') }, t('label.endGuess')));
  if (f.content) out.push(h('span', { class: 'label label-warn', title: t('label.contentTitle') }, t('label.content')));
  if (f.party) out.push(h('span', { class: 'label label-warn' }, t('label.party')));
  if (f.creative) out.push(h('span', { class: 'label label-warn', title: t('label.creativeTitle') }, t('label.creative')));
  if (c.manual) out.push(h('span', { class: 'label' }, t('label.manual')));
  if (c.origin === 'web') out.push(h('span', { class: 'label', title: t('label.webTitle') }, t('label.web')));
  if (c.origin === 'ig') out.push(h('span', { class: 'label', title: t('label.igTagTitle') }, t('label.igTag')));
  if (c.gone) out.push(h('span', { class: 'label', title: t('label.goneTitle') }, t('label.gone')));
  if (r.hidden && ui.showHidden) out.push(h('span', { class: 'label', title: t('label.hiddenTitle') }, t('label.hidden', { r: t(`reason.${r.hidden}`) })));
  if (r.st === 'skipped') out.push(h('span', { class: 'label' }, t('label.skipped')));
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
  push(h('span', null, t('meta.until', { d: fmtDay(c.end) })));
  const prizes = L.prizesOf(c, it);
  if (prizes) push(h('span', null, tn('meta.prizes', prizes)));
  const pf = platformName(c.platform);
  if (pf) push(h('span', null, pf));
  if (isDone && it.at) push(h('span', null, t('meta.enteredOn', { d: fmtDay(it.at) })));
  const res = L.resultsOf(c, it);
  if (res && (isDone || st === 'todo')) push(h('span', null, t('meta.results', { d: fmtDay(res) })));

  const star = h(
    'button',
    {
      type: 'button',
      class: `btn btn-sm btn-invisible btn-icon star${st === 'todo' ? ' on' : ''}`,
      title: st === 'todo' ? t('star.remove') : t('star.add'),
      'aria-pressed': st === 'todo' ? 'true' : 'false',
      'aria-label': t('star.aria'),
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
      title: isDone ? t('cb.undo') : t('cb.mark'),
      'aria-label': t('cb.aria', { title: c.title }),
      onchange: (e) => {
        setStatus(c, e.target.checked ? 'submitted' : '');
        toast(e.target.checked ? t('toast.submitted') : t('toast.unsubmitted'));
      },
    }),
    stateIcon(st, dl),
    h(
      'div',
      { class: 'item-main' },
      h('button', { type: 'button', class: 'item-title', onclick: () => openContest(c.id) }, c.title || t('untitled')),
      h('span', { class: 'item-labels' }, labelsFor(r)),
      h('div', { class: 'item-meta' }, meta),
    ),
    h(
      'div',
      { class: 'item-side' },
      h('span', { class: `meta-pill due ${dueClass(dl)}`, title: t('meta.endTitle', { d: fmtDay(c.end, true) }) }, icon('clock', { size: 14 }), rel(dl)),
      h(
        'span',
        { class: 'meta-pill', title: comments ? t('meta.commentsTitle', { d: fmtDay(comments.at) }) : t('meta.commentsUnknown') },
        icon('comment', { size: 14 }),
        comments ? String(comments.n) : '?',
      ),
      oddsEl(odds, r.early),
      star,
    ),
  );
}

function boxEl(title, list, emptyText, cls = '') {
  const box = h('div', { class: `box ${cls}`.trim(), role: 'list' });
  if (title) box.append(h('div', { class: 'box-header' }, title));
  if (!list.length) {
    if (emptyText) box.append(h('div', { class: 'box-empty' }, emptyText));
  } else list.forEach((r) => box.append(itemEl(r)));
  return box;
}

/** Zwijana sekcja „Z zakupem” na końcu listy; na górze konkursy pasujące do zainteresowań. */
function purchaseBox(list) {
  const mine = list.filter((r) => r.interests.length);
  const ordered = [...mine, ...list.filter((r) => !r.interests.length)];
  const open = Boolean(ui.purchaseOpen || ui.q.trim()); // przy wyszukiwaniu zawsze rozwinięta
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'box-toggle',
      'aria-expanded': open ? 'true' : 'false',
      title: open ? t('purchase.collapse') : t('purchase.expand'),
      onclick: () => {
        ui.purchaseOpen = !open;
        saveUi();
        renderList();
      },
    },
    icon('chevron', { cls: 'chevron' }),
    h(
      'span',
      { class: 'box-title' },
      icon('cart'),
      ` ${t('purchase.title')} `,
      h('span', { class: 'counter' }, String(list.length)),
      h('span', { class: 'muted box-note' }, mine.length ? t('purchase.noteMine', { n: mine.length }) : t('purchase.note')),
    ),
  );
  return boxEl(toggle, open ? ordered : [], '', `box-purchase${open ? ' is-open' : ''}`);
}

function renderTabs(all) {
  const nav = $('#tabs');
  nav.replaceChildren(
    ...TABS.map((tab) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tab',
          role: 'tab',
          'aria-selected': ui.tab === tab.id ? 'true' : 'false',
          onclick: () => {
            ui.tab = tab.id;
            saveUi();
            render();
          },
        },
        icon(tab.icon),
        t(`tab.${tab.id}`),
        h('span', { class: 'counter' }, String(all.filter((r) => inTab(r, tab.id)).length)),
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
    placeholder: t('search.placeholder'),
    'aria-label': t('search.placeholder'),
    value: ui.q,
    oninput: (e) => {
      ui.q = e.target.value;
      renderList();
    },
  });
  // Opcje: [wartość, tekst] albo { group, options } (grupa <optgroup>).
  const opt = (key, [v, text]) => h('option', { value: v, selected: ui[key] === v }, text);
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
      options.map((o) => (Array.isArray(o) ? opt(key, o) : h('optgroup', { label: o.group }, o.options.map((x) => opt(key, x))))),
    );
  const catOptions = [
    ['all', t('filter.allKinds')],
    ['mine', t('filter.forYou')],
    ['purchase', t('filter.purchase')],
    { group: t('filter.groupPlatform'), options: PLATFORM_CATS.map((p) => [p, platformName(p)]) },
    { group: t('filter.groupKind'), options: L.KIND_ORDER.map((k) => [k, t(`kind.${k}`)]) },
  ];
  $('#toolbar').replaceChildren(
    h('div', { class: 'search' }, icon('search'), search),
    sel('f-cat', t('filter.kindAria'), catOptions, 'cat'),
    sel('f-sort', t('sort.aria'), [['deadline', t('sort.deadline')], ['value', t('sort.value')], ['odds', t('sort.odds')], ['new', t('sort.new')]], 'sort'),
    h(
      'label',
      { class: 'check', title: t('hidden.title') },
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
      h('span', { id: 'f-hidden-label' }, t('hidden.toggle', { n: 0 })),
    ),
  );
}

function renderStats(all) {
  const submitted = all.filter((r) => L.DONE.has(r.st)).length;
  const won = all.filter((r) => r.st === 'won').length;
  const lost = all.filter((r) => r.st === 'lost').length;
  // Wyjazdy, wartościowe i nowe – bez konkursów z zakupem (te mają własny licznik).
  const openFree = all.filter((r) => inTab(r, 'open', false) && !r.purchase);
  const stays = openFree.filter((r) => L.flagsOf(r.c).stay).length;
  const valuable = openFree.filter((r) => L.isValuable(r.prize)).length;
  const fresh = openFree.filter((r) => r.isNew).length;
  const forYou = all.filter((r) => inTab(r, 'open', false) && r.interests.length && !r.purchase).length;
  const purchase = all.filter((r) => inTab(r, 'open', false) && r.purchase).length;
  const hiddenCount = all.filter((r) => (r.dl === null || r.dl >= 0) && !L.DONE.has(r.st) && (r.hidden || r.st === 'skipped')).length;
  $('#f-hidden-label').textContent = t('hidden.toggle', { n: hiddenCount });
  const part = (label, value) => h('span', null, label, ' ', h('strong', null, String(value)));
  const stats = [part(t('stats.forYou'), forYou), part(t('stats.purchase'), purchase), part(t('stats.entered'), submitted), part(t('stats.won'), won)];
  if (won + lost > 0) stats.push(part(t('stats.rate'), `${Math.round((won / (won + lost)) * 100)}%`));
  stats.push(part(t('stats.trips'), stays));
  stats.push(part(t('stats.valuable', { v: tr.money(L.VALUABLE_FROM) }), valuable));
  if (fresh) stats.push(part(t('stats.new'), fresh));
  $('#stats').replaceChildren(...stats);
}

function renderList() {
  const all = rows();
  const list = sortRows(all.filter((r) => inTab(r, ui.tab) && matches(r)));
  const root = $('#list');
  const empty = t(`empty.${ui.tab}`);
  const boxes = [];
  if (catalogError) boxes.push(h('div', { class: 'flash flash-warn' }, t(catalogError)));
  // Zakładka „Otwarte”: konkursy z zakupem (loterie, paragony, aplikacje) w osobnej, zwijanej sekcji na końcu.
  const split = ui.tab === 'open' && ui.cat === 'all';
  const paid = split ? list.filter((r) => r.purchase) : [];
  const free = split ? list.filter((r) => !r.purchase) : list;
  if ((ui.tab === 'open' || ui.tab === 'todo') && ui.cat === 'all' && (ui.sort === 'deadline' || ui.sort === 'odds') && free.length) {
    // Najpierw „Dla Ciebie” (zainteresowania), potem sekcje według rodzaju nagrody: wyjazdy, sprzęt, bony, pozostałe
    const mine = free.filter((r) => r.interests.length);
    if (mine.length) {
      const names = L.settingsOf(state).interests.list.map((id) => t(`interest.${id}`)).join(', ');
      boxes.push(
        boxEl(
          h('span', { class: 'box-title' }, icon('heart'), ` ${t('forYou.title')} `, h('span', { class: 'counter' }, String(mine.length)), h('span', { class: 'muted box-note' }, t('forYou.note', { list: names }))),
          mine,
          '',
          'box-foryou',
        ),
      );
    }
    for (const kind of L.KIND_ORDER) {
      const part = free.filter((r) => r.prize.kind === kind && !r.interests.length);
      if (!part.length) continue;
      const valuable = part.filter((r) => L.isValuable(r.prize)).length;
      boxes.push(
        boxEl(
          h(
            'span',
            { class: 'box-title' },
            icon(KIND_ICON[kind]),
            ` ${t(`kind.${kind}`)} `,
            h('span', { class: 'counter' }, String(part.length)),
            valuable ? h('span', { class: 'muted box-note' }, t('list.valuable', { n: valuable })) : null,
          ),
          part,
          '',
        ),
      );
    }
  } else if (free.length || !paid.length) {
    boxes.push(boxEl(h('span', null, tn('list.count', free.length)), free, empty));
  }
  if (paid.length) boxes.push(purchaseBox(paid));
  root.replaceChildren(...boxes);
  return all;
}

function renderSyncButton() {
  const btn = $('#btn-sync');
  const cls = { ok: 'ok', busy: 'busy', err: 'err', local: '' }[syncInfo.kind] || '';
  btn.className = `btn btn-sm btn-invisible sync ${cls}`;
  btn.title = sync ? `${t(syncInfo.key)}${sync.login ? ` (@${sync.login})` : ''}` : t('sync.btnLocalTitle');
  btn.replaceChildren(h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'sync-text' }, sync ? t(syncInfo.key) : t('sync.btnLocal')));
}

function renderFooter() {
  const f = $('#footer');
  const upd = catalog.updatedAt ? new Date(catalog.updatedAt) : null;
  const parts = [
    h('span', null, t('footer.list'), ' ', upd ? upd.toLocaleString(tr.lang === 'en' ? 'en-GB' : 'pl-PL', { dateStyle: 'medium', timeStyle: 'short' }) : '—', ` (${(catalog.contests || []).length})`),
    h(
      'span',
      null,
      t('footer.source'),
      ' ',
      extLink('https://www.e-konkursy.info/', 'e-konkursy.info'),
      ` ${t('footer.andWeb')}`,
      (catalog.contests || []).some((c) => c.origin === 'ig') ? ` · ${t('footer.ig')}` : '',
    ),
    site.apkUrl && !inAndroidApp ? h('span', null, h('a', { href: site.apkUrl }, icon('android', { size: 12 }), ' ', t('footer.android'))) : null,
    h('span', null, h('a', { href: 'privacy.html' }, t('footer.privacy'))),
    site.repoUrl ? h('span', null, extLink(site.repoUrl, t('footer.code'))) : null,
    h(
      'span',
      { class: 'shortcuts' },
      t('footer.shortcuts'),
      ' ',
      h('span', { class: 'kbd' }, '/'),
      ` ${t('footer.search')}, `,
      h('span', { class: 'kbd' }, 'c'),
      ` ${t('footer.add')}, `,
      h('span', { class: 'kbd' }, 'r'),
      ` ${t('footer.refresh')}`,
    ),
  ];
  f.replaceChildren(...parts.filter(Boolean));
}

function renderChrome() {
  $('#brand-tagline').textContent = t('brand.tagline');
  const settingsBtn = $('#btn-settings');
  settingsBtn.title = t('btn.settings');
  settingsBtn.setAttribute('aria-label', t('btn.settings'));
  settingsBtn.replaceChildren(icon('sliders'));
  const addBtn = $('#btn-add');
  addBtn.title = t('btn.addTitle');
  addBtn.replaceChildren(icon('plus'), h('span', { class: 'btn-add-text' }, t('btn.add')));
  renderRefreshButton();
  renderSyncButton();
}

function render() {
  buildToolbar();
  const all = renderList();
  renderTabs(all);
  renderStats(all);
  renderSyncButton();
  renderFooter();
}

/** Po zmianie języka: przebuduj wszystko, łącznie z paskiem filtrów i otwartymi oknami. */
function rerenderAll() {
  toolbarBuilt = false;
  renderChrome();
  render();
  if ($('#dlg-settings').open) renderSettings();
  if (openId && $('#dlg-contest').open) renderContest(openId);
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

function sidebarSection(title, ...content) {
  return h('div', { class: 'sidebar-section' }, h('div', { class: 'sidebar-title' }, title), h('div', { class: 'sidebar-value' }, ...content));
}

function commentBox(title, body, extra) {
  return h('div', { class: 'comment' }, h('div', { class: 'comment-header' }, h('span', null, title), extra || null), body);
}

function debounce(fn, ms) {
  let timer = null;
  return (...a) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
}

function renderContest(id) {
  const dlg = $('#dlg-contest');
  const r = findRow(id);
  if (!r) {
    toast(t('toast.notFound'));
    if (dlg.open) dlg.close();
    return;
  }
  openId = id;
  const { c, it, st, dl, odds } = r;
  const f = L.flagsOf(c);
  const today = L.todayISO();

  const badge =
    st === 'won'
      ? h('span', { class: 'state state-badge-won' }, icon('trophy'), t('state.won'))
      : st === 'lost'
        ? h('span', { class: 'state state-badge-closed' }, icon('lost'), t('state.lost'))
        : st === 'submitted'
          ? h('span', { class: 'state state-badge-done' }, icon('done'), t('state.submitted'))
          : st === 'skipped'
            ? h('span', { class: 'state state-badge-closed' }, icon('skip'), t('state.skipped'))
            : dl !== null && dl < 0
              ? h('span', { class: 'state state-badge-closed' }, icon('closed'), t('state.closed'))
              : h('span', { class: 'state state-badge-open' }, icon('open'), t('state.open'));

  // --- kolumna główna ---
  const main = h('div', null);
  const taskSrc = c.origin === 'web' ? t('detail.taskWeb') : c.origin === 'ig' ? t('detail.taskIg') : c.manual ? '' : t('detail.taskSrc');
  if (c.task) main.append(commentBox(h('span', null, h('strong', null, t('detail.task')), taskSrc), h('div', { class: 'comment-body' }, c.task), extLink(c.src, t('detail.source'))));
  if (c.prizes) main.append(commentBox(h('strong', null, t('detail.prizes')), h('div', { class: 'comment-body' }, c.prizes)));

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
            i === 0 && answers.length > 1 ? h('span', { class: 'label label-draw' }, t('detail.recommended')) : null,
            h('button', { type: 'button', class: 'btn btn-sm', onclick: () => copyText(a) }, icon('copy'), t('btn.copy')),
          ),
        ),
      ),
    );
    main.append(commentBox(h('strong', null, t('detail.answers')), list, h('span', { class: 'hint' }, t('detail.answersHint'))));
  }

  const saveAnswer = debounce((v) => setItem(c.id, { answer: v }), 600);
  const myAnswer = h('textarea', { class: 'input', rows: 4, placeholder: t('detail.myAnswerPh'), oninput: (e) => saveAnswer(e.target.value) }, it.answer || '');
  main.append(
    commentBox(
      h('strong', null, t('detail.myAnswer')),
      h('div', { class: 'comment-body', style: 'white-space:normal' }, myAnswer),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => copyText(myAnswer.value) }, icon('copy'), t('btn.copy')),
    ),
  );
  const saveNote = debounce((v) => setItem(c.id, { note: v }), 600);
  main.append(
    commentBox(
      h('strong', null, t('detail.note')),
      h('div', { class: 'comment-body', style: 'white-space:normal' }, h('textarea', { class: 'input', rows: 3, placeholder: t('detail.notePh'), oninput: (e) => saveNote(e.target.value) }, it.note || '')),
    ),
  );

  // --- pasek boczny ---
  const side = h('div', null);
  const statusSel = h(
    'select',
    {
      class: 'input',
      'aria-label': t('detail.status'),
      onchange: (e) => {
        setStatus(c, e.target.value);
        renderContest(id);
      },
    },
    L.STATUSES.map((v) => h('option', { value: v, selected: st === v }, t(`status.${v}`))),
  );
  side.append(sidebarSection(t('detail.status'), statusSel));
  if (L.DONE.has(st)) {
    side.append(sidebarSection(t('detail.enteredOn'), h('input', { class: 'input', type: 'date', value: it.at || '', onchange: (e) => setItem(c.id, { at: e.target.value || undefined }) })));
  }
  side.append(
    sidebarSection(
      t('detail.deadline'),
      h('span', { class: `due ${dueClass(dl)}` }, rel(dl)),
      h('div', { class: 'hint' }, t('detail.until', { d: fmtDay(c.end, true) }) + (c.start ? t('detail.from', { d: fmtDay(c.start, true) }) : '')),
    ),
  );
  side.append(
    sidebarSection(
      t('detail.results'),
      h('input', {
        class: 'input',
        type: 'date',
        value: L.resultsOf(c, it) || '',
        onchange: (e) => {
          setItem(c.id, { results: e.target.value || undefined });
          renderContest(id);
        },
      }),
      h('div', { class: 'hint' }, L.resultsOf(c, it) ? t('detail.resultsHint') : t('detail.resultsHintNone')),
    ),
  );

  const cm = L.commentsOf(c, it);
  const cmInput = h('input', { class: 'input', type: 'number', min: '0', step: '1', inputmode: 'numeric', value: cm ? String(cm.n) : '', placeholder: t('detail.commentsPh'), 'aria-label': t('detail.commentsAria') });
  const saveComments = () => {
    const v = cmInput.value.trim();
    if (v === '') return;
    const n = Math.max(0, Math.round(Number(v)));
    if (!Number.isFinite(n)) return;
    setItem(c.id, { comments: n, commentsAt: today });
    toast(t('toast.commentsSaved'));
    renderContest(id);
  };
  cmInput.addEventListener('keydown', (e) => e.key === 'Enter' && saveComments());
  side.append(
    sidebarSection(
      t('detail.comments'),
      h('div', { class: 'inline-form' }, cmInput, h('button', { type: 'button', class: 'btn btn-sm', onclick: saveComments }, t('detail.save'))),
      h('div', { class: 'hint' }, cm ? t('detail.checked', { d: fmtDay(cm.at) }) : t('detail.unknown'), extLink(c.url, t('detail.openPost'))),
    ),
  );
  side.append(
    sidebarSection(
      t('detail.prizeCount'),
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
      t('detail.prize'),
      h('div', null, icon(KIND_ICON[pz.kind]), ' ', t(`kind.${pz.kind}`)),
      pz.value !== null ? h('div', { style: 'margin-top:4px' }, prizeLabel(pz)) : h('div', { class: 'hint' }, t('detail.valueUnknown')),
      pz.estimated ? h('div', { class: 'hint' }, t('detail.estimate')) : null,
    ),
  );
  side.append(sidebarSection(t('detail.odds'), oddsEl(odds, r.early), h('div', { class: 'hint' }, r.early ? t('odds.early') : t('detail.oddsHint'))));

  const req = [];
  if (f.follow) req.push(t('req.follow'));
  if (f.tags) req.push(tn('req.tags', f.tags));
  if (f.fbShare) req.push(t('req.fbShare'));
  if (f.igShare) req.push(t('req.igShare'));
  if (f.shareOptional && !f.fbShare && !f.igShare) req.push(t('req.shareOptional'));
  if (f.purchase) req.push(t('req.purchase'));
  if (f.app) req.push(t('req.app'));
  if (f.content) req.push(t('req.content'));
  if (f.creative) req.push(t('req.creative'));
  side.append(
    sidebarSection(
      t('detail.req'),
      req.length ? h('ul', { style: 'margin:0;padding-left:18px' }, req.map((x) => h('li', null, x))) : h('span', { class: 'muted' }, t('req.commentOnly')),
      h('div', { class: 'hint' }, t('req.checkRules')),
    ),
  );
  if (c.org || c.platform) side.append(sidebarSection(t('detail.organizer'), c.org || '—', platformName(c.platform) ? h('div', { class: 'hint' }, platformName(c.platform)) : null));
  const srcHost = (() => {
    try {
      return new URL(c.src).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const srcLabel = !srcHost || srcHost === 'e-konkursy.info' ? t('detail.linkSrc') : t('detail.linkSrcOther', { host: srcHost });
  side.append(sidebarSection(t('detail.links'), h('div', { style: 'display:grid;gap:4px' }, extLink(c.url, t('detail.linkPost')), c.src && c.src !== c.url ? extLink(c.src, srcLabel) : null)));

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
            toast(t('toast.skipped'));
            dlg.close();
          },
        },
        icon('skip'),
        t('detail.skip'),
      ),
    );
  }
  if (c.manual) {
    actions.append(h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openAdd(c.id) }, icon('pencil'), t('detail.edit')));
    actions.append(
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-sm btn-danger',
          onclick: () => {
            if (!confirm(t('detail.deleteConfirm'))) return;
            state.manual[c.id] = { ...state.manual[c.id], deleted: true, t: Date.now() };
            commit();
            dlg.close();
            toast(t('toast.deleted'));
          },
        },
        icon('trash'),
        t('detail.delete'),
      ),
    );
  }
  if (actions.childElementCount) side.append(sidebarSection(t('detail.actions'), actions));

  const body = h(
    'div',
    { class: 'dlg-body' },
    h('h1', { class: 'issue-title', id: 'dlg-contest-title' }, c.title || t('untitled')),
    h('div', { class: 'issue-sub' }, badge, h('span', null, `${rel(dl)} · ${t('detail.until', { d: fmtDay(c.end, true) })}`), h('span', { class: 'item-labels' }, labelsFor({ ...r, hidden: '' }))),
    h('div', { class: 'layout' }, main, side),
  );
  const head = h(
    'div',
    { class: 'dlg-header' },
    h('h2', null, t('detail.heading')),
    !L.DONE.has(st)
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-sm btn-primary',
            onclick: () => {
              setStatus(c, 'submitted');
              toast(t('toast.submitted'));
              renderContest(id);
            },
          },
          icon('done'),
          t('detail.markEntered'),
        )
      : null,
    h('button', { type: 'button', class: 'btn btn-sm btn-invisible btn-icon', 'aria-label': t('btn.close'), onclick: () => dlg.close() }, icon('x')),
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
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, change ? t('token.save') : t('token.connect'));
    return h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          btn.disabled = true;
          btn.textContent = t('token.connecting');
          try {
            const login = await connect(tokenInput.value);
            toast(t('toast.connected', { login }));
          } catch (err) {
            toast(err.status === 401 ? t('toast.badToken') : err.status === 403 || err.status === 404 ? t('toast.noGistPerm') : t('toast.connectFailed'));
          }
          renderSettings();
        },
      },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'set-token' }, change ? t('token.labelNew') : t('token.label')),
        h('div', { class: 'inline-form' }, tokenInput, btn),
        h(
          'ol',
          { class: 'hint steps' },
          h('li', null, extLink(L.tokenTemplateUrl(), t('token.step1')), t('token.step1b')),
          h('li', null, t('token.step2a'), h('strong', null, 'Only select repositories'), t('token.step2b', { repo: site.repo })),
          h('li', null, t('token.step3')),
        ),
        h('div', { class: 'hint' }, t('token.note')),
      ),
    );
  };
  const syncSec = [];
  if (sync) {
    syncSec.push(
      h(
        'div',
        { class: `flash ${syncInfo.kind === 'err' ? 'flash-warn' : 'flash-ok'}` },
        h('strong', null, syncInfo.kind === 'err' ? t(syncInfo.key) : t('settings.connectedAs', { login: sync.login })),
        h('div', { class: 'hint' }, t('settings.gistInfo'), extLink(`https://gist.github.com/${sync.login}/${sync.gistId}`, t('settings.openGist'))),
        h('div', { class: 'hint' }, t('settings.gistId'), h('code', null, 'STATE_GIST_ID'), ': ', h('code', null, sync.gistId)),
      ),
      h(
        'div',
        { class: 'btn-group' },
        h('button', { type: 'button', class: 'btn', onclick: () => syncNow().then(() => renderSettings()) }, icon('refresh'), t('settings.syncNow')),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-danger',
            onclick: () => {
              disconnect();
              renderSettings();
              toast(t('toast.disconnected'));
            },
          },
          t('settings.disconnect'),
        ),
      ),
      h('details', { style: 'margin-top:12px' }, h('summary', { class: 'hint' }, t('settings.changeToken')), h('div', { style: 'margin-top:8px' }, tokenForm(true))),
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
        if (applyLang()) rerenderAll();
        toast(t('toast.sessionLoaded'));
        renderSettings();
      } catch {
        toast(t('toast.notSession'));
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
    placeholder: t('ntfy.topicPh'),
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
  const ntfyBox = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: n[key], onchange: (e) => setSettings((x) => (x.ntfy[key] = e.target.checked)) }), label);
  const hideBox = (key) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.hide[key], onchange: (e) => setSettings((x) => (x.hide[key] = e.target.checked)) }), t(`hide.${key}`));

  const theme = lsGet(K.theme, 'auto') || 'auto';

  const body = h(
    'div',
    { class: 'dlg-body' },
    settingsSection(
      t('settings.sync'),
      t('settings.syncDesc'),
      ...syncSec,
      h(
        'div',
        { class: 'btn-group', style: 'margin-top:12px' },
        h('button', { type: 'button', class: 'btn', onclick: exportSession }, icon('download'), t('session.export')),
        h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, icon('upload'), t('session.import')),
        fileInput,
      ),
    ),
    h(
      'section',
      { class: 'settings-section', id: 'set-ntfy' },
      h('h3', null, t('ntfy.title')),
      h('p', null, t('ntfy.desc')),
      !sync ? h('div', { class: 'flash flash-warn' }, t('ntfy.needSync')) : null,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: n.enabled, onchange: (e) => setSettings((x) => (x.ntfy.enabled = e.target.checked)) }), h('strong', null, t('ntfy.enabled'))),
      h(
        'div',
        { class: 'field', style: 'margin-top:12px' },
        h('label', { for: 'set-topic' }, t('ntfy.topic')),
        h(
          'div',
          { class: 'inline-form' },
          topicInput,
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              title: t('ntfy.random'),
              onclick: () => {
                setSettings((x) => (x.ntfy.topic = L.randomTopic()));
                renderSettings();
              },
            },
            icon('refresh'),
          ),
          h('button', { type: 'button', class: 'btn', title: t('btn.copy'), onclick: () => copyText(L.settingsOf(state).ntfy.topic) }, icon('copy')),
        ),
        h('div', { class: 'hint' }, t('ntfy.topicHint')),
      ),
      h('div', { class: 'label-text' }, t('ntfy.remind')),
      h('div', { class: 'row-fields' }, dayBox(3, t('ntfy.d3')), dayBox(2, t('ntfy.d2')), dayBox(1, t('ntfy.d1')), dayBox(0, t('ntfy.d0'))),
      h('div', { class: 'label-text', style: 'margin-top:12px' }, t('ntfy.which')),
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'radio', name: 'scope', checked: n.scope === 'all', onchange: () => setSettings((x) => (x.ntfy.scope = 'all')) }),
        h(
          'span',
          null,
          t('ntfy.scopeAll'),
          h('input', {
            class: 'input mono',
            type: 'number',
            min: '1',
            style: 'width:90px;min-height:24px;padding:0 6px;margin-left:4px',
            value: String(n.maxOdds),
            onchange: (e) => setSettings((x) => (x.ntfy.maxOdds = Math.max(1, Math.round(Number(e.target.value) || 150)))),
          }),
          t('ntfy.scopeAllTail'),
        ),
      ),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'scope', checked: n.scope === 'todo', onchange: () => setSettings((x) => (x.ntfy.scope = 'todo')) }), t('ntfy.scopeTodo')),
      h(
        'div',
        { style: 'margin-top:8px' },
        ntfyBox('newInterests', t('ntfy.newInterests')),
        ntfyBox('newPurchase', t('ntfy.newPurchase')),
        ntfyBox('newStays', t('ntfy.newStays')),
        ntfyBox('newValuable', t('ntfy.newValuable', { v: tr.money(L.VALUABLE_FROM) })),
        ntfyBox('results', t('ntfy.results')),
      ),
      h(
        'details',
        { style: 'margin:8px 0' },
        h('summary', { class: 'hint' }, t('ntfy.server')),
        h('input', {
          class: 'input mono',
          value: n.server,
          style: 'margin-top:8px',
          onchange: (e) => setSettings((x) => (/^https?:\/\//.test(e.target.value.trim()) ? (x.ntfy.server = e.target.value.trim()) : null)),
        }),
      ),
      h('button', { type: 'button', class: 'btn', onclick: sendTest }, icon('bell'), t('ntfy.test')),
    ),
    settingsSection(
      t('forYou.settingsTitle'),
      t('forYou.settingsDesc'),
      L.INTERESTS.map((id) =>
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: s.interests.list.includes(id),
            onchange: (e) =>
              setSettings((x) => {
                const on = new Set(x.interests.list);
                if (e.target.checked) on.add(id);
                else on.delete(id);
                x.interests.list = L.INTERESTS.filter((k) => on.has(k));
              }),
          }),
          h('span', null, h('strong', null, t(`interest.${id}`)), ' – ', t(`interest.${id}Desc`, { n: L.GOOD_ODDS })),
        ),
      ),
    ),
    settingsSection(t('filters.title'), t('filters.desc'), Object.keys(L.DEFAULT_SETTINGS.hide).map(hideBox), h('div', { class: 'hint' }, t('filters.purchaseNote'))),
    settingsSection(
      t('look.title'),
      null,
      h(
        'div',
        { class: 'btn-group' },
        h(
          'select',
          {
            class: 'input',
            style: 'max-width:240px',
            'aria-label': t('lang.aria'),
            onchange: (e) => setSettings((x) => (x.lang = e.target.value)),
          },
          h('option', { value: 'auto', selected: s.lang === 'auto' }, t('lang.auto')),
          h('option', { value: 'pl', selected: s.lang === 'pl' }, 'Polski'),
          h('option', { value: 'en', selected: s.lang === 'en' }, 'English'),
        ),
        h(
          'select',
          {
            class: 'input',
            style: 'max-width:240px',
            'aria-label': t('theme.aria'),
            onchange: (e) => {
              const v = e.target.value;
              lsSet(K.theme, v === 'auto' ? null : v);
              if (v === 'auto') delete document.documentElement.dataset.theme;
              else document.documentElement.dataset.theme = v;
            },
          },
          h('option', { value: 'auto', selected: theme === 'auto' }, t('theme.auto')),
          h('option', { value: 'light', selected: theme === 'light' }, t('theme.light')),
          h('option', { value: 'dark', selected: theme === 'dark' }, t('theme.dark')),
        ),
      ),
      h('div', { class: 'hint', style: 'margin-top:8px' }, t('lang.hint')),
    ),
    site.apkUrl && !inAndroidApp
      ? settingsSection(t('android.title'), t('android.desc'), h('a', { class: 'btn', href: site.apkUrl }, icon('android'), t('android.download')))
      : null,
    settingsSection(
      t('device.title'),
      t('device.desc'),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-danger',
          onclick: () => {
            if (!confirm(t('device.confirm'))) return;
            lsSet(K.state, null);
            lsSet(K.sync, null);
            state = L.emptyState();
            sync = null;
            setSync('local', 'sync.local');
            if (applyLang()) rerenderAll();
            else render();
            renderSettings();
            toast(t('toast.dataCleared'));
          },
        },
        icon('trash'),
        t('device.clear'),
      ),
    ),
  );
  const head = h(
    'div',
    { class: 'dlg-header' },
    h('h2', { id: 'dlg-settings-title' }, t('settings.title')),
    h('button', { type: 'button', class: 'btn btn-sm btn-invisible btn-icon', 'aria-label': t('btn.close'), onclick: () => dlg.close() }, icon('x')),
  );
  const scroll = dlg.querySelector('.dlg-body') ? dlg.querySelector('.dlg-body').scrollTop : 0;
  dlg.replaceChildren(head, body);
  body.scrollTop = scroll;
}

async function sendTest() {
  const n = L.settingsOf(state).ntfy;
  if (!n.topic) {
    toast(t('toast.topicFirst'));
    return;
  }
  try {
    // Bez nagłówka Content-Type – prosty request bez preflightu CORS.
    const res = await fetch(n.server.replace(/\/+$/, '') + '/', {
      method: 'POST',
      body: JSON.stringify({ topic: n.topic, title: t('ntfy.testTitle'), message: t('ntfy.testMsg'), tags: ['tada'], click: site.appUrl }),
    });
    toast(res.ok ? t('toast.testSent') : t('toast.ntfyStatus', { s: res.status }));
  } catch {
    toast(t('toast.testFailed'));
  }
}

function exportSession() {
  const blob = new Blob([JSON.stringify({ app: 'lootsy', exportedAt: new Date().toISOString(), state }, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `lootsy-session-${L.todayISO()}.json` });
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
  const field = (id, label, input) => h('div', { class: 'field' }, h('label', { for: id }, label), input);
  const title = h('input', { id: 'a-title', class: 'input', required: true, value: old ? old.title || '' : '', placeholder: t('add.namePh') });
  const url = h('input', { id: 'a-url', class: 'input', type: 'url', required: true, value: old ? old.url || '' : '', placeholder: 'https://www.facebook.com/…' });
  const end = h('input', { id: 'a-end', class: 'input', type: 'date', required: true, value: old ? old.end || '' : '', min: old ? undefined : today });
  const prizes = h('textarea', { id: 'a-prizes', class: 'input', rows: 2, placeholder: t('add.prizesPh') }, old ? old.prizes || '' : '');
  const prizeCount = h('input', { id: 'a-pc', class: 'input', type: 'number', min: '1', value: old && old.prizeCount ? String(old.prizeCount) : '' });
  const comments = h('input', { id: 'a-cm', class: 'input', type: 'number', min: '0', value: old && old.comments !== undefined ? String(old.comments) : '' });
  const task = h('textarea', { id: 'a-task', class: 'input', rows: 3, placeholder: t('add.taskPh') }, old ? old.task || '' : '');
  const stay = h('input', { type: 'checkbox', checked: Boolean(old && old.flags && old.flags.stay) });

  const form = h(
    'form',
    {
      onsubmit: (e) => {
        e.preventDefault();
        if (!safeUrl(url.value.trim())) {
          toast(t('toast.needUrl'));
          return;
        }
        const id = old ? old.id : `m:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const platform = L.platformOf(url.value.trim());
        const { flags, judging } = L.classify({ title: title.value, task: task.value, prizes: prizes.value, platform });
        flags.stay = stay.checked;
        const pc = Math.round(Number(prizeCount.value));
        const cm = comments.value.trim() === '' ? null : Math.round(Number(comments.value));
        state.manual[id] = L.cleanContest({
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
        commit();
        dlg.close();
        toast(old ? t('toast.saved') : t('toast.added'));
        openContest(id);
      },
    },
    h(
      'div',
      { class: 'dlg-body' },
      field('a-title', t('add.name'), title),
      field('a-url', t('add.url'), url),
      h('div', { class: 'row-fields' }, field('a-end', t('add.end'), end), field('a-pc', t('add.prizeCount'), prizeCount), field('a-cm', t('add.comments'), comments)),
      field('a-prizes', t('add.prizes'), prizes),
      field('a-task', t('add.task'), task),
      h('label', { class: 'check' }, stay, t('add.stay')),
    ),
    h(
      'div',
      { class: 'dlg-footer' },
      h('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, t('add.cancel')),
      h('button', { type: 'submit', class: 'btn btn-primary' }, old ? t('add.save') : t('add.submit')),
    ),
  );
  dlg.replaceChildren(
    h(
      'div',
      { class: 'dlg-header' },
      h('h2', { id: 'dlg-add-title' }, old ? t('add.editTitle') : t('add.title')),
      h('button', { type: 'button', class: 'btn btn-sm btn-invisible btn-icon', 'aria-label': t('btn.close'), onclick: () => dlg.close() }, icon('x')),
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
      catalogError = 'catalog.offline';
    } else {
      catalogError = 'catalog.error';
    }
  }
}

function routeFromHash() {
  const m = location.hash.match(/^#c=(.+)$/);
  if (m) renderContest(decodeURIComponent(m[1]));
  else if ($('#dlg-contest').open) $('#dlg-contest').close();
}

function setupChrome() {
  renderChrome();
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-add').addEventListener('click', () => openAdd());
  $('#btn-refresh').addEventListener('click', refreshList);
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
    const el = e.target;
    const typing = el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
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
  applyLang();
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
