# Konkursy

Minimalistyczna aplikacja do śledzenia konkursów w mediach społecznościowych, w stylu GitHuba.
Działa w całości na GitHubie: aplikacja na GitHub Pages, robot w GitHub Actions, Twoje dane w prywatnym giście.

## Co potrafi

- **Lista aktualnych konkursów** – robot codziennie rano pobiera je z [e-konkursy.info](https://www.e-konkursy.info/).
- **Noclegi i wyjazdy na górze** – osobna sekcja dla pobytów, hoteli, apartamentów i wycieczek.
- **Filtry** – domyślnie ukrywa imprezy, konkursy z obowiązkowym udostępnianiem na Facebooku, zakupowe, „z aplikacją” i wymagające zdjęcia (poza wyjazdami). Wszystko do zmiany w ustawieniach.
- **Terminy i szanse** – kolorowe terminy („jutro”, „za 3 dni”) i szansa ≈ komentarze ÷ liczba nagród.
- **Odhaczanie zgłoszeń** – pole przy każdym konkursie; statusy: Planuję ★, Zgłoszone, Wygrane, Przegrane, Pominięte.
- **Gotowe odpowiedzi** – z przyciskiem „Kopiuj”, plus miejsce na własną odpowiedź i notatkę.
- **Własna sesja** – synchronizacja telefon ↔ komputer przez prywatny gist oraz eksport/import sesji do pliku.
- **Powiadomienia na telefon (ntfy)** – koniec terminu, dzień ogłoszenia wyników, nowe konkursy z noclegiem.
- **Na telefonie jak aplikacja** – działa offline i można ją dodać do ekranu głównego; jasny i ciemny motyw.

## Jak to działa

```
e-konkursy.info ──► robot (GitHub Actions, codziennie) ──► site/data/contests.json ──► GitHub Pages
                                                                                          │
                     prywatny gist ◄── statusy, notatki, ustawienia (Twój token) ─────────┘
                          │
                          └──► robot/notify.mjs (GitHub Actions) ──► ntfy.sh ──► telefon
```

| Część | Plik |
|---|---|
| Aplikacja (bez frameworków i budowania) | `site/index.html`, `site/app.js`, `site/style.css` |
| Wspólna logika: filtry, szanse, łączenie stanu, powiadomienia | `site/logic.js` |
| Robot pobierający konkursy | `robot/scrape.mjs`, `robot/parse.mjs` |
| Ręczne uzupełnienia (liczby komentarzy, gotowe odpowiedzi) | `data/curated.json` |
| Powiadomienia | `robot/notify.mjs` |
| Automatyzacje | `.github/workflows/robot.yml` (codziennie), `.github/workflows/pages.yml` (testy + publikacja) |

## Pierwsze uruchomienie

1. **Synchronizacja** – w aplikacji: Ustawienia → *Utwórz token* (zaznaczone tylko uprawnienie `gist`) → wklej token → *Połącz*. Zrób to na każdym urządzeniu.
2. **Powiadomienia** – zainstaluj aplikację [ntfy](https://ntfy.sh/) (Android / iPhone), kliknij **+** i wpisz nazwę kanału z ustawień aplikacji. Przycisk *Wyślij powiadomienie testowe* sprawdzi, czy działa.
3. **Sekret robota** – robot czyta Twoje ustawienia z gista o identyfikatorze zapisanym w sekrecie repozytorium `STATE_GIST_ID` (Settings → Secrets and variables → Actions). Identyfikator pokazuje się w ustawieniach aplikacji po połączeniu synchronizacji.

Robota można uruchomić ręcznie: zakładka **Actions → Robot → Run workflow**.

## Liczba komentarzy

Facebook i Instagram blokują automatyczne odczytywanie postów, więc robot nie pobiera liczby komentarzy.
Wpisujesz ją w szczegółach konkursu (obok jest link do posta), a szansa przelicza się sama.
Liczby dla części konkursów są też w `data/curated.json`.

## Prywatność

- Repozytorium jest publiczne: kod i lista konkursów (informacje i tak publiczne).
- Twoje statusy, notatki i ustawienia są w **sekretnym giście**. Nie da się go wyszukać, ale każdy, kto zna jego adres, może go przeczytać – nie wpisuj tam haseł ani danych osobowych.
- Identyfikator gista jest tylko w sekrecie repozytorium i w Twojej przeglądarce.
- Token zostaje wyłącznie w przeglądarce (localStorage) i ma tylko uprawnienie `gist`.
- Logi robota są publiczne, więc nie zawierają nazw konkursów, statusów ani nazwy kanału ntfy.
- Nazwa kanału ntfy działa jak hasło: kto ją zna, widzi powiadomienia.

## Praca lokalna

Wymaga Node.js 22+. Bez instalowania zależności.

```bash
npm run dev      # podgląd aplikacji: http://localhost:4173
npm test         # testy
npm run scrape   # pobranie konkursów do site/data/contests.json
DRY_RUN=1 STATE_FILE=moj-stan.json npm run notify   # podgląd powiadomienia bez wysyłania
```

## Licencja

MIT – zobacz [LICENSE](LICENSE).
