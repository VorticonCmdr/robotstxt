# robots.txt emulator

Eine Chrome-Extension (Manifest V3), die `robots.txt`-Regeln für den normalen Browser-Traffic durchsetzt. Ruft beim Besuch einer Domain deren `robots.txt` ab und blockiert alle Anfragen, die die dortigen Regeln verbieten — genau so, wie ein Crawler es täte.

---

## Inhaltsverzeichnis

1. [Motivation](#motivation)
2. [Funktionen](#funktionen)
3. [Architektur](#architektur)
   - [Warum zwei Mechanismen?](#warum-zwei-mechanismen)
   - [Blockieren via declarativeNetRequest](#blockieren-via-declarativenetrequest)
   - [Protokollieren via webRequest](#protokollieren-via-webrequest)
   - [Der Service Worker](#der-service-worker)
   - [Datenspeicherung](#datenspeicherung)
4. [Dateiübersicht](#dateiübersicht)
5. [Entwicklung und Build](#entwicklung-und-build)
6. [Extension laden](#extension-laden)
7. [Nutzung](#nutzung)
   - [Popup](#popup)
   - [Live-Protokoll](#live-protokoll)
   - [robots.txt-Cache](#robotstxt-cache)
   - [Optionen](#optionen)
8. [Bekannte Einschränkungen](#bekannte-einschränkungen)

---

## Motivation

`robots.txt` ist eine Konvention für Web-Crawler: Betreiber einer Website erklären darin, welche Pfade automatisierte Programme nicht aufrufen sollen. Browser halten sich nicht daran — sie sind keine Crawler. Diese Extension schließt diese Lücke: Sie liest `robots.txt` wie ein Crawler und blockiert im Browser exakt die Pfade, die dort als `Disallow` markiert sind.

Nützlich z. B. wenn man:
- das eigene `robots.txt` testen möchte, bevor ein Crawler es auswertet,
- nachvollziehen möchte, welche Teile einer Seite für Bots gesperrt sind,
- den eigenen Browser absichtlich wie einen bestimmten Bot (z. B. Googlebot) verhalten lassen will.

---

## Funktionen

- **Automatisches Abrufen** der `robots.txt` beim ersten Besuch jeder Domain. Das Ergebnis wird 24 Stunden im Cache gehalten (bis zu 500 KB pro Datei).
- **Echtes Blockieren** über Chrome DNR-Regeln (`declarativeNetRequest`): gesperrte URLs werden vom Browser abgebrochen, bevor die Anfrage das Netz erreicht.
- **Wählbarer User-Agent**: Standardmäßig wird die `*`-Gruppe ausgewertet; in den Optionen kann auf `Googlebot` (oder einen anderen bekannten Agenten) umgestellt werden.
- **Live-Protokoll**: Zeigt in Echtzeit, welche URLs geblockt wurden — mit Tab-Filter, Spalten für Methode, Typ, Reason und Referrer sowie klickbarer Verlinkung zur genauen `robots.txt`-Zeile.
- **robots.txt-Cache-Editor**: Zeigt die gespeicherten `robots.txt`-Texte aller besuchten Domains mit annotierter, direkt editierbarer Ansicht, Tab-Filter, Suchfeld und URL-Tester.
- **Blocking-Checkbox**: Das Blockieren lässt sich im Popup per Checkbox deaktivieren; alle DNR-Regeln werden entfernt und beim erneuten Aktivieren sofort wiederhergestellt.
- **Persistenz über Browser-Neustarts**: Regeln bleiben als Chrome-DNR-Dynamic-Rules erhalten; ein Neustart des Service Workers löscht keine Daten.

---

## Architektur

### Warum zwei Mechanismen?

Manifest V3 hat das blockierende `webRequest` (`["blocking"]`) entfernt. Blockieren geschieht nur noch über deklarative Regeln (`declarativeNetRequest`, kurz DNR). Diese Regeln werden *im Voraus* installiert und arbeiten ohne JavaScript. Das hat Konsequenzen:

| Aspekt | Manifest V2 (alt) | Manifest V3 (jetzt) |
|--------|-------------------|---------------------|
| Blockieren | `webRequest` mit `["blocking"]` — pro Request, in JS | `declarativeNetRequest` — deklarative Regeln, vor dem Request |
| Entscheidung | Einzelner Aufruf von `canVisit(url)` im Hintergrund | Regeln werden vorab pro Domain installiert |
| Logger | Direkt im blockierenden Listener | Separater non-blocking `webRequest`-Observer |
| Hintergrund | Persistente Hintergrundseite | Ephemerer Service Worker |

Die Extension nutzt deshalb **zwei Kanäle gleichzeitig**:

```
Navigation → robots.txt abrufen → DNR-Regeln installieren → Chrome blockiert Requests
                                                              ↓
                         non-blocking webRequest-Observer → Logger (Live-Protokoll)
```

### Blockieren via declarativeNetRequest

`src/dnr.js` übersetzt `robots.txt`-Pfade in DNR-Regeln:

- Jeder `Disallow:`-Pfad wird zu einer `block`-Regel.
- Jeder `Allow:`-Pfad wird zu einer `allow`-Regel.
- Statt `regexFilter` (RE2) wird `urlFilter` verwendet — Chrome limitiert dynamische Regex-Regeln auf 1 000; `urlFilter` hat kein solches Zusatzlimit. Das `urlFilter`-Format (`|` = Linanker links/rechts, `*` = Wildcard) bildet alle benötigten robots.txt-Muster exakt ab.
- Die **Priorität** einer Regel ergibt sich aus `1 + Musterlänge`: längere (spezifischere) Muster gewinnen. Bei Gleichstand bevorzugt DNR automatisch `allow` über `block` — das spiegelt die robots.txt-Konvention (Allow schlägt Disallow bei gleicher Spezifität) exakt wider.
- DNR-Regeln werden pro Domain dynamisch installiert (`chrome.declarativeNetRequest.updateDynamicRules`) und überleben den SW-Neustart.
- Das Limit für dynamische Regeln liegt bei 30 000; die Extension hält sich unter 28 000 und verdrängt bei Bedarf die ältesten Domains (LRU-Eviction).

### Protokollieren via webRequest

`src/background.js` registriert einen **non-blocking** `webRequest.onBeforeRequest`-Listener. Dieser:

1. Lädt den gecachten `robots.txt`-Text für die betreffende Domain.
2. Ruft `RobotsMatcher.oneAgentAllowedByRobots(text, agent, url)` aus der Bibliothek [`google-robotstxt-parser`](https://www.npmjs.com/package/google-robotstxt-parser) auf — das ist die maßgebliche Entscheidung (Googles C++-Parser, nach JS portiert).
3. Wenn die URL geblockt sein sollte, ermittelt `findMatchingLine()` (aus `src/extract.js`) die genaue Zeilennummer der auslösenden `Disallow`-Regel und sendet eine `logline`-Nachricht mit allen Details (URL, Methode, Ressourcentyp, Reason, Zeilennummer, Referrer) an das Live-Protokoll.

Dieser Listener kann keine Requests abbrechen (kein `["blocking"]`). Das tatsächliche Blockieren macht ausschließlich DNR. Der Observer dient nur der Protokollierung und dem Lazy-Fetch noch unbekannter Domains.

Die Entscheidung fällt damit **zweimal**: DNR (approximativ, deklarativ) und Matcher (ground truth, für den Logger). Kleine Abweichungen zwischen beiden sind ein dokumentierter Kompromiss.

### Der Service Worker

`src/background.js` ist der Service Worker. Er:

- Registriert **alle Listener synchron beim Start** (top-level), damit sie nach jedem SW-Aufwachen sofort aktiv sind.
- Hält ein kleines In-Memory-Shadow für `enabled` und `preferredAgent`, das beim Aufwachen aus `chrome.storage.local` geladen wird (`settingsReady`-Promise).
- **Besitzt alle DNR-Mutationen**: Seiten (Popup, Cache-Editor, Optionen) senden Intent-Nachrichten; der SW führt Storage-Schreiboperationen und DNR-Regelaktualisierungen atomar durch.
- Dedupliziert parallele Fetches derselben Domain mit einem `inFlight`-Set.

**HTTP-Status → robots.txt-Text** (Semantik aus MV2 beibehalten):

| HTTP-Status | Ergebnis |
|-------------|----------|
| `200` | Inhalt (auf 500 000 Bytes / 500 KB begrenzt) |
| `5xx` / Timeout | `Disallow: /` (alles blockiert) |
| `204`, `4xx`, Netzwerkfehler | `Allow: /` (alles erlaubt) |

### Datenspeicherung

Alle Daten liegen in `chrome.storage.local`:

| Schlüssel | Inhalt |
|-----------|--------|
| `r:<protocol://host>` | `{ text, status, timestamp, ruleIds: number[] }` — ein Eintrag pro Domain |
| `state` | `true` / `false` — Extension aktiv oder nicht |
| `preferredRecordGroup` | Gewählter User-Agent, z. B. `*` oder `Googlebot` |
| `nextRuleId` | Monoton steigender Zähler für DNR-Regel-IDs |
| `loggerFocusTab` | Zuletzt aktiver Tab-ID aus dem Popup (für Logger-Synchronisation) |

Das Präfix `r:` trennt Domain-Einträge von den Settings-Schlüsseln.

---

## Dateiübersicht

```
manifest.json          Manifest V3 (Build-Einstiegspunkt für CRXJS)
vite.config.js         Vite + CRXJS-Plugin-Konfiguration
package.json           npm-Abhängigkeiten und Build-Skripte

src/
  background.js        Service Worker: Fetch, Navigation→Regeln, Observer→Logger, Messages
  dnr.js               robots.txt-Pfade → DNR-Regeln (urlFilter); Installieren/Evict/Löschen
  extract.js           Allow/Disallow-Pfade + findMatchingLine() aus robots.txt extrahieren
  cache.js             chrome.storage.local-Helfer + DNR-Regel-ID-Vergabe
  popup.js             Aktions-Popup: Blocking-Checkbox, Navigation zu anderen Seiten
  logger.js            Live-Blockierungsprotokoll (logger.html)
  robots.js            Cache-Ansicht/-Editor (robots.html)
  options.js           User-Agent-Auswahl + Cache leeren (options.html)

popup.html             Popup (in manifest.json referenziert)
options.html           Optionsseite (in manifest.json referenziert)
logger.html            Live-Protokoll (zur Laufzeit geöffnet)
robots.html            Cache-Editor (zur Laufzeit geöffnet)

icons/                 PNG-Icons in verschiedenen Größen
dist/                  Build-Ausgabe (wird als Extension geladen)
```

---

## Entwicklung und Build

**Voraussetzungen:** Node.js ≥ 18, npm

```bash
# Abhängigkeiten installieren
npm install

# Produktions-Build (dist/ wird erstellt/aktualisiert)
npm run build

# Entwicklungs-Server mit HMR (Hot Module Replacement)
npm run dev
```

Der Build nutzt [Vite](https://vite.dev) mit dem [@crxjs/vite-plugin](https://crxjs.dev/vite-plugin). Das Plugin liest `manifest.json` als Build-Einstiegspunkt und bündelt den Service Worker sowie alle HTML-Seiten inklusive ihrer npm-Imports automatisch.

`logger.html` und `robots.html` sind nicht im Manifest referenziert (sie werden zur Laufzeit per `chrome.tabs.create` geöffnet) und werden deshalb explizit als `rollupOptions.input` in `vite.config.js` deklariert.

---

## Extension laden

1. `npm run build` ausführen (einmalig oder nach Änderungen).
2. In Chrome `chrome://extensions` öffnen.
3. **Entwicklermodus** oben rechts aktivieren.
4. **„Entpackte Extension laden"** klicken und das Verzeichnis **`dist/`** auswählen.
5. Die Extension erscheint mit dem Roboter-Icon in der Toolbar.

Nach Codeänderungen genügt es, `npm run build` erneut auszuführen und auf der Extensions-Seite die Schaltfläche **„Neu laden"** (↺) zu klicken.

---

## Nutzung

### Popup

Ein Klick auf das Extension-Icon in der Toolbar öffnet das Popup. Es enthält:

| Element | Funktion |
|---|---|
| **Blocking** (Checkbox) | Blockierung ein-/ausschalten. Im deaktivierten Zustand werden alle DNR-Regeln entfernt; beim erneuten Aktivieren werden sie sofort neu installiert. Das Icon wechselt zwischen farbig (aktiv) und grau (inaktiv). |
| **live protocol** | Öffnet das Live-Protokoll in einem neuen Tab. Der aktuelle Tab wird automatisch im Protokoll vorausgewählt. |
| **robots.txt cache** | Öffnet den Cache-Editor in einem neuen Tab. |
| **options** | Öffnet die Optionsseite in einem neuen Tab. |

### Live-Protokoll

`logger.html` — zeigt in Echtzeit alle Requests, die als geblockt erkannt wurden. Dark-Theme, nutzt die volle Fensterbreite.

**Tabellenspalten:**

| Spalte | Inhalt |
|--------|--------|
| Time | Uhrzeit des Requests (HH:MM:SS) |
| Method | HTTP-Methode (GET, POST, …) |
| URL | Vollständige geblockte URL |
| Type | Ressourcentyp als farbiges Badge (document, script, xhr, image, …) |
| Reason | `robots-disallow` (Disallow-Regel gefunden) oder `robots-unavailable` (robots.txt nicht erreichbar → alles gesperrt) |
| Line | Zeilennummer der auslösenden Disallow-Regel in der `robots.txt` — klickbar, öffnet direkt den Cache-Editor an der richtigen Zeile |
| Referrer | Initiator des Requests (aufrufende Seite) |

**Bedienung:**
- **Clear display**: Leert die angezeigte Tabelle (in-memory-Einträge werden ebenfalls gelöscht).
- **Download JSON**: Exportiert alle protokollierten Einträge als JSON-Datei.
- **Tab-Selektor** (oben rechts): Filtert die Ansicht auf einen bestimmten Tab. Wird automatisch auf den aktuell aktiven Tab gesetzt, wenn das Popup geöffnet wird.

Die neuesten Einträge erscheinen oben. Ein Neuladen der Seite leert die Tabelle.

### robots.txt-Cache

`robots.html` — verwaltet den lokalen `robots.txt`-Cache mit einer annotierten, editierbaren Ansicht. Helles Design.

**Bedienung:**

- **Tab-Selektor**: Filtert die Host-Liste auf Domains, die auf dem gewählten Tab sichtbar sind. „all tabs" zeigt alle gecachten Domains.
- **Suchfeld** (mit Datalist-Autovervollständigung): Wählt den gewünschten Host aus. Beim Tab-Filter wird bei einem eindeutigen Treffer automatisch geladen.
- **Update**: Speichert den bearbeiteten Text und installiert sofort neue DNR-Regeln für diese Domain.
- **Clear selected**: Löscht den Eintrag und alle zugehörigen Blockierungsregeln. Beim nächsten Besuch wird `robots.txt` neu abgerufen.
- **Clear all**: Löscht sämtliche gecachten Einträge und alle DNR-Regeln.

**Annotierte Ansicht:**

- Jede Zeile zeigt Zeilennummer, ein farbiges Indikator-Icon und den Zeilentext.
- `Allow`-Regeln sind grün markiert, `Disallow`-Regeln rot, Fehler werden mit einem Badge ausgewiesen.
- Die Zeilen sind **direkt editierbar** (kein separater Texteditor nötig): in jede Zeile klicken und tippen. Enter fügt eine neue Zeile ein, Backspace am Zeilenanfang fügt die Zeile mit der vorherigen zusammen. Mehrzeiliges Einfügen (Paste) wird korrekt verarbeitet.
- Beim Tippen werden Indikatoren und Badges live aktualisiert.

**URL-Tester** (untere Leiste):

- URL eingeben (z. B. `https://example.com/admin/`) → sofortiges Ergebnis: **ALLOWED** oder **BLOCKED**.
- Optionales Agent-Feld: testet mit einem anderen User-Agent als dem in den Optionen gewählten.
- Die auslösende Zeile wird in der annotierten Ansicht grün hervorgehoben.

**Deep-Links:**

Die Seite unterstützt direkte Verlinkung über URL-Parameter:
- `robots.html?host=https://example.com` — lädt direkt den Eintrag für diesen Host.
- `robots.html?host=https://example.com&line=42` — lädt den Eintrag und scrollt zu Zeile 42 (z. B. vom Live-Protokoll aus).

### Optionen

`options.html` — zwei Einstellungen:

**Preferred record group (User-Agent)**

Legt fest, welche User-Agent-Gruppe aus `robots.txt` ausgewertet wird:

- `*` (Standard): Die Catch-all-Gruppe gilt für alle nicht namentlich genannten Bots.
- `Googlebot`: Die für Googlebot spezifischen Regeln werden angewendet. Hat eine `robots.txt` keinen Googlebot-Abschnitt, greift automatisch `*`.

Ein Wechsel des Agenten löst sofort eine Neuberechnung aller DNR-Regeln für alle gecachten Domains aus.

**Empty stored robots.txt cache**

Löscht alle gecachten Einträge und DNR-Regeln — identisch mit „Clear all" im Cache-Editor.

---

## Bekannte Einschränkungen

**Erste-Anfrage-Lücke (First-Visit Race)**
MV3 bietet keinen Mechanismus, einen Request zu pausieren, bis Regeln installiert sind. Beim allerersten Besuch einer Domain kann der `main_frame`-Request ankommen, bevor die DNR-Regeln installiert wurden. Alle nachfolgenden Besuche sind durch die persistierten Regeln abgedeckt.

**DNR-Approximation vs. Matcher-Wahrheit**
Die DNR-Regeln sind eine best-effort-Übersetzung von `robots.txt`-Mustern in `urlFilter`-Ausdrücke. Die endgültige Entscheidung im Live-Protokoll trifft `RobotsMatcher.oneAgentAllowedByRobots()` — Googles offizielle Implementierung. In seltenen Fällen können DNR-Block und Matcher-Ergebnis leicht voneinander abweichen.

**Nur HTTP/HTTPS**
`robots.txt` ist für Web-Traffic definiert. `chrome-extension://`-, `file://`- und andere Schemata werden ignoriert.

**Cache-TTL 24 Stunden**
`robots.txt`-Änderungen auf dem Server werden erst nach Ablauf von 24 Stunden oder manuellem Cache-Löschen wirksam.

**DNR-Limit**
Chrome erlaubt maximal 30 000 dynamische Regeln insgesamt. Die Extension reserviert 2 000 als Puffer und verdrängt bei Bedarf die am längsten nicht besuchten Domains (LRU-Eviction). Bei sehr vielen besuchten Domains mit langen `robots.txt`-Dateien können ältere Einträge automatisch aus dem Blockierungsregelsatz entfernt werden (der Cache-Eintrag bleibt erhalten).
