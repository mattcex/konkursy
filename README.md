# Lootsy – konkursy i rozdania

Minimalistyczna aplikacja do śledzenia konkursów w mediach społecznościowych, w stylu GitHuba.
Działa w całości na GitHubie: strona na GitHub Pages, aplikacja na Androida (Trusted Web Activity), robot w GitHub Actions, Twoje dane w prywatnym giście.

**Aplikacja:** https://mattcex.github.io/konkursy/ · **Android (APK):** https://github.com/mattcex/konkursy/releases/latest/download/lootsy.apk

*English below.*

## Co potrafi

- **Lista aktualnych konkursów** – robot codziennie rano pobiera je z [e-konkursy.info](https://www.e-konkursy.info/).
- **Przycisk „Odśwież”** – uruchamia robota od razu (GitHub Actions), czeka na wynik i oznacza nowe konkursy etykietą „nowy”.
- **Podział według nagród** – sekcje: Wycieczki i noclegi, Sprzęt, Bony i gotówka, Pozostałe; sortowanie po wartości nagrody.
- **Wyróżnione wartościowe nagrody** – od 1000 zł złote tło i etykieta 💎 z kwotą (z opisu albo szacunkową, oznaczoną „~”).
- **Filtry** – domyślnie ukrywa imprezy, konkursy z obowiązkowym udostępnianiem na Facebooku, zakupowe, „z aplikacją”, wymagające zdjęcia (poza wyjazdami) i wymagające pracy twórczej (eseje, wiersze, nagrania, projekty).
- **Terminy i szanse** – kolorowe terminy („jutro”, „za 3 dni”) i szansa ≈ komentarze ÷ liczba nagród.
- **Odhaczanie zgłoszeń** – statusy: Planuję ★, Zgłoszone, Wygrane, Przegrane, Pominięte.
- **Gotowe odpowiedzi** – z przyciskiem „Kopiuj”, plus własna odpowiedź i notatka.
- **Własna sesja** – synchronizacja telefon ↔ komputer przez prywatny gist oraz eksport/import sesji do pliku.
- **Powiadomienia na telefon (ntfy)** – koniec terminu, dzień wyników, nowe noclegi i wartościowe nagrody.
- **Polski i angielski** – język wykrywany automatycznie albo wybrany w ustawieniach (także w powiadomieniach).
- **Na telefonie jak aplikacja** – APK na Androida, działanie offline, jasny i ciemny motyw.

## Jak to działa

```
e-konkursy.info ──► robot (GitHub Actions, codziennie) ──► site/data/contests.json ──► GitHub Pages ──► Android (TWA)
                                                                                          │
                     prywatny gist ◄── statusy, notatki, ustawienia (Twój token) ─────────┘
                          │
                          └──► robot/notify.mjs (GitHub Actions) ──► ntfy.sh ──► telefon
```

| Część | Plik |
|---|---|
| Aplikacja (bez frameworków i budowania) | `site/index.html`, `site/app.js`, `site/style.css` |
| Tłumaczenia PL/EN | `site/i18n.js` |
| Wspólna logika: filtry, szanse, nagrody, łączenie stanu, powiadomienia | `site/logic.js` |
| Robot pobierający konkursy | `robot/scrape.mjs`, `robot/parse.mjs` |
| Ręczne uzupełnienia (liczby komentarzy, gotowe odpowiedzi) | `data/curated.json` |
| Powiadomienia | `robot/notify.mjs` |
| Aplikacja na Androida | `android/` (Gradle, Trusted Web Activity), opis do sklepu: `android/store/listing.md` |
| Automatyzacje | `.github/workflows/robot.yml` (codziennie; po zmianach zleca publikację), `pages.yml` (testy + strona), `android.yml` (APK/AAB) |

## Pierwsze uruchomienie

1. **Token** – w aplikacji: Ustawienia → *Otwórz formularz tokenu*. Uprawnienia **Gists** (synchronizacja) i **Actions** (przycisk „Odśwież”) są już zaznaczone; w „Repository access” wybierz *Only select repositories* → `konkursy`. Kliknij *Generate token*, wklej go w aplikacji → *Połącz*. Zrób to na każdym urządzeniu.
2. **Powiadomienia** – zainstaluj aplikację [ntfy](https://ntfy.sh/) (Android / iPhone), kliknij **+** i wpisz nazwę kanału z ustawień aplikacji. Przycisk *Wyślij powiadomienie testowe* sprawdzi, czy działa.
3. **Sekret robota** – robot czyta Twoje ustawienia z gista o identyfikatorze zapisanym w sekrecie repozytorium `STATE_GIST_ID` (Settings → Secrets and variables → Actions).

Robota można uruchomić przyciskiem **Odśwież** w aplikacji (skrót `r`) albo w zakładce **Actions → Robot → Run workflow**.
Odświeżenie z aplikacji nie wysyła powiadomień – te przychodzą tylko z porannego przebiegu.

## Aplikacja na Androida

Aplikacja to Trusted Web Activity: otwiera stronę https://mattcex.github.io/konkursy/ na pełnym ekranie, więc każda zmiana strony od razu trafia do aplikacji (bez nowej wersji APK).
Plik https://mattcex.github.io/.well-known/assetlinks.json (repozytorium `mattcex.github.io`) potwierdza, że strona i aplikacja `io.github.mattcex.lootsy` mają tego samego właściciela.

Workflow `android.yml` buduje `lootsy.apk` (instalacja na telefonie) i `lootsy.aab` (Google Play) i publikuje je w **Releases**. Wymaga trzech sekretów repozytorium (klucz przesyłania, przechowywany poza repozytorium):

| Sekret | Zawartość |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | plik klucza `lootsy-upload.p12` zakodowany w base64 |
| `ANDROID_KEYSTORE_PASSWORD` | hasło do klucza |
| `ANDROID_KEY_ALIAS` | `lootsy` |

Bez nich workflow tylko sprawdza, czy aplikacja się kompiluje, i zapisuje testowy APK jako artefakt.
**Klucza nie wolno zgubić** – każda aktualizacja APK musi być podpisana tym samym kluczem.

Publikacja w Google Play: konto w Play Console (jednorazowo 25 USD), wgranie `lootsy.aab`, opis z `android/store/listing.md`, polityka prywatności `site/privacy.html`. Po włączeniu „Podpisywania aplikacji przez Google Play” dopisz odcisk SHA-256 klucza Google do `assetlinks.json`.

## Liczba komentarzy

Facebook i Instagram blokują automatyczne odczytywanie postów, więc robot nie pobiera liczby komentarzy.
Wpisujesz ją w szczegółach konkursu (obok jest link do posta), a szansa przelicza się sama.

## Prywatność

Szczegóły: [site/privacy.html](site/privacy.html) (https://mattcex.github.io/konkursy/privacy.html).

- Repozytorium jest publiczne: kod i lista konkursów (informacje i tak publiczne).
- Twoje statusy, notatki i ustawienia są w **sekretnym giście**. Nie da się go wyszukać, ale każdy, kto zna jego adres, może go przeczytać – nie wpisuj tam haseł ani danych osobowych.
- Token zostaje wyłącznie w przeglądarce (localStorage) i ma tylko dwa uprawnienia: gisty oraz uruchamianie Actions w tym jednym repozytorium.
- Logi robota są publiczne, więc nie zawierają nazw konkursów, statusów ani nazwy kanału ntfy.

## Praca lokalna

Wymaga Node.js 22+. Bez instalowania zależności.

```bash
npm run dev      # podgląd aplikacji: http://localhost:4173
npm test         # testy
npm run scrape   # pobranie konkursów do site/data/contests.json
npm run icons    # ikony strony i Androida
DRY_RUN=1 STATE_FILE=moj-stan.json npm run notify   # podgląd powiadomienia bez wysyłania
```

---

## English

**Lootsy** is a minimalist, GitHub-styled tracker for social-media contests and giveaways (currently Polish contests from e-konkursy.info).
It groups contests by prize (trips & stays, gear, vouchers, other), highlights the most valuable ones, shows deadlines and estimated odds, lets you tick off entries, keep notes and ready-made answers, syncs between devices through a private GitHub gist and sends phone reminders via ntfy.
The interface is available in Polish and English (auto-detected or chosen in settings); contest descriptions stay in their original language.

- Web app: https://mattcex.github.io/konkursy/
- Android APK: https://github.com/mattcex/konkursy/releases/latest/download/lootsy.apk
- Privacy policy: https://mattcex.github.io/konkursy/privacy.html

## Licencja / License

MIT – zobacz [LICENSE](LICENSE).
