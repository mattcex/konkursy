// Robot: codzienne powiadomienia ntfy (kończące się konkursy, dzień wyników, nowe noclegi).
// Ustawienia i statusy czyta z prywatnego (sekretnego) gista z synchronizacji aplikacji.
//
// Zmienne środowiskowe:
//   STATE_GIST_ID – identyfikator gista ze stanem (sekret repozytorium)
//   STATE_FILE    – zamiast gista: lokalny plik ze stanem (testy)
//   APP_URL       – adres aplikacji (link w powiadomieniu); domyślnie GitHub Pages repozytorium
//   DRY_RUN=1     – tylko wypisz wiadomość, nic nie wysyłaj
//
// Repozytorium jest publiczne, więc logi Actions też są publiczne: nie wypisujemy w nich
// nazw konkursów, statusów ani kanału ntfy.

import { readFile } from 'node:fs/promises';
import { STATE_FILE, allContests, buildDigest, normalizeState, pickNotifications, settingsOf, todayISO } from '../site/logic.js';

const DRY = Boolean(process.env.DRY_RUN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appUrl() {
  if (process.env.APP_URL) return process.env.APP_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) return '';
  const [owner, name] = repo.split('/');
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${name}/` : `https://${owner}.github.io/${name}/`;
}

async function loadGist(id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.github.com/gists/${encodeURIComponent(id)}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'KonkursyTracker/1.0', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (res.ok) {
        const gist = await res.json();
        const file = gist.files && gist.files[STATE_FILE];
        if (!file) throw new Error(`w giście brakuje pliku ${STATE_FILE}`);
        const text = file.truncated ? await (await fetch(file.raw_url)).text() : file.content;
        return JSON.parse(text);
      }
      console.warn(`GitHub API: HTTP ${res.status}`);
      if (res.status === 404) return null;
    } catch (e) {
      console.warn(`Nie udało się wczytać stanu: ${e.message}`);
    }
    await sleep(2000 * attempt);
  }
  return null;
}

async function main() {
  const catalog = JSON.parse(await readFile(new URL('../site/data/contests.json', import.meta.url), 'utf8'));
  let raw = null;
  if (process.env.STATE_FILE) raw = JSON.parse(await readFile(process.env.STATE_FILE, 'utf8'));
  else if (process.env.STATE_GIST_ID) raw = await loadGist(process.env.STATE_GIST_ID.trim());
  else {
    console.log('Brak sekretu STATE_GIST_ID – powiadomienia wyłączone.');
    return;
  }
  if (!raw) {
    console.log('Nie udało się wczytać stanu – pomijam powiadomienia.');
    return;
  }
  const state = normalizeState(raw);
  const { ntfy } = settingsOf(state);
  if (!ntfy.enabled || !ntfy.topic) {
    console.log('Powiadomienia wyłączone w ustawieniach albo brak kanału ntfy.');
    return;
  }
  const today = todayISO();
  const picks = pickNotifications(allContests(catalog, state), state, today);
  const msg = buildDigest(picks, { appUrl: appUrl() });
  if (!msg) {
    console.log('Dziś nie ma o czym przypominać.');
    return;
  }
  const count = picks.ending.length + picks.newStays.length + picks.results.length;
  if (DRY) {
    console.log(JSON.stringify(msg, null, 2));
    return;
  }
  const res = await fetch(ntfy.server.replace(/\/+$/, '') + '/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: ntfy.topic, ...msg }),
  });
  if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`);
  console.log(`Wysłano powiadomienie (pozycji: ${count}).`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
