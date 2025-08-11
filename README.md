# README.md – Caspar Autosync (20 slots)

**Syfte**
Hålla uppspelning av **upp till 20 förinspelade källor** i fas över en eller flera CasparCG‑servrar, för "låtsas‑live"/utställning där besökare kan klippa i en ATEM i efterhand. Systemet använder **dubbellager** (aktiv/standby) för sömlös **CUT/FADE‑resync** och har tre lägen: **OFF / AUTO / MANUAL**.

> Transparens: Lösningen bygger på dokumenterade mönster i CasparCG/AMCP och inte på egna fysiska erfarenheter.

---

## Innehåll

* [Funktioner](#funktioner)
* [Arkitektur i korthet](#arkitektur-i-korthet)
* [Systemkrav](#systemkrav)
* [Installera på Windows – steg för steg](#installera-på-windows--steg-för-steg)
* [VS Code & GitHub‑flöde](#vs-code--github-flöde)
* [Projektstruktur & .gitignore](#projektstruktur--gitignore)
* [Konfiguration](#konfiguration)

  * [Globala inställningar](#globala-inställningar)
  * [Slots (20 st) via GUI](#slots-20-st-via-gui)
  * [Exempel `config.sample.json`](#exempel-configsamplejson)
  * [Timecode → frames](#timecode--frames)
* [Drift & användning](#drift--användning)
* [API för Companion/extern styrning](#api-för-companionextern-styrning)
* [Köra i produktion](#köra-i-produktion)
* [Brandvägg & portar](#brandvägg--portar)
* [Felsökning](#felsökning)
* [FAQ](#faq)
* [Licens](#licens)

---

## Funktioner

* 🔁 **Autosync**: resynkar med valt intervall **endast** om |drift| > tolerans (i frames).
* ✂️ **Resync-lägen**: `CUT` (omedelbar) eller `FADE` (1–n frames micro‑fade).
* 🧱 **Dubbellager per slot**: `baseLayer` = aktivt lager, `baseLayer+10` = standby (roller byts vid resync).
* 🧩 **20 slots i GUI**: Ange **Host/IP, Port, Kanal, Bas‑lager, Clip, Timecode** (HH\:MM\:SS\:FF). Tomma slots ignoreras.
* 🕒 **Start från TC**: Starta alla från valfri timecode per slot.
* 💾 **Persistent config**: Servern sparar inställningar i `config.json` (överlever reloads & olika webbläsare).
* 🖥️ **Mörkt, modernt webb‑GUI** med live‑status (WebSocket), driftmätning, mode‑badges och snabbkommandon.

---

## Arkitektur i korthet

* **Node.js‑server** (Express) som styr CasparCG via **AMCP** (bibliotek: `casparcg-connection`).
* **Webb‑GUI** (statisk HTML/CSS/JS) som pratar HTTP + WebSocket med servern.
* **Dubbellager‑metod**: varje slot har ett aktivt och ett standby‑lager (±10) för sömlös CUT/FADE och atomiska byten.

---

## Systemkrav

* **Windows 10/11** (fungerar även macOS/Linux) för kontrollservern.
* **Node.js LTS** (18 eller 20 rekommenderas).
* **CasparCG 2.3.x LTS** på varje playout‑dator (AMCP 5250).
* **Blackmagic Desktop Video** + korrekt routad SDI i Caspar‑konfig.
* **Intra‑only** media (ProRes / DNxHR / H.264 All‑Intra). Enhetlig **fps** och **längd (frames)** för alla källor.
* **Rekommenderat**: NTP på alla maskiner + genlock till SDI‑korten/ATEM.

---

## Installera på Windows – steg för steg

1. **Installera Node.js LTS** från \[nodejs.org]. Verifiera:

   ```powershell
   node -v
   npm -v
   ```
2. **Kopiera projektet** (Git eller zip):

   ```powershell
   git clone <din-github-url> caspar-autosync
   cd caspar-autosync
   ```
3. **Skapa konfigfil** från mallen:

   ```powershell
   copy config.sample.json config.json
   ```

   (Du kan lämna `slots` tomma – de fylls i via GUI.)
4. **Installera beroenden och starta**:

   ```powershell
   npm install
   npm start
   ```
5. **Öppna GUI**: `http://localhost:8080` (eller `http://<server-ip>:8080`).

> Alternativ: `scripts/start-windows.bat` gör steg 4–5.

---

## VS Code & GitHub‑flöde

* **Öppna mappen** `caspar-autosync/` i VS Code.
* Använd **NPM Scripts**‑panelen eller terminalen (`npm start`).
* **.gitignore** utesluter `node_modules/` och **`config.json`** (personlig server‑state).
* Skapa ny **GitHub‑repo** och pusha mappen. Lämna `config.json` utanför repo (genereras per miljö).

---

## Projektstruktur & .gitignore

```
caspar-autosync/
├─ .gitignore                 # node_modules/, config.json, .env, logs/
├─ package.json               # npm‑manifest & scripts
├─ README.md                  # denna fil
├─ config.sample.json         # globala defaults; kopieras till config.json
├─ config.json                # persistent server‑state (skapas av dig/GUI) – ignoreras i Git
├─ index.js                   # Node‑server + AMCP‑logik + autosync
├─ public/                    # statiska GUI‑filer
│  ├─ index.html              # mörkt, responsivt GUI
│  ├─ style.css               # tema + layout
│  └─ app.js                  # klientlogik (WebSocket + API)
└─ scripts/
   └─ start-windows.bat       # valfritt startskript
```

**.gitignore (förslag)**

```
node_modules/
config.json
.env
logs/
.DS_Store
npm-debug.log*
```

---

## Konfiguration

### Globala inställningar

I `config.json` (skapad från `config.sample.json`):

* `fps`: Hela systemets bildfrekvens (t.ex. 50 eller 25).
* `frames`: Totalt antal frames per klipp/loop (t.ex. 10 min @50 fps = 30 000).
* `autosyncIntervalSec`: Hur ofta AUTO kontrollerar och ev. resynkar.
* `driftToleranceFrames`: Tolerans i frames innan resync triggas.
* `resyncMode`: `cut` eller `fade`.
* `fadeFrames`: längd på FADE i frames (1–4 brukar fungera fint).

### Slots (20 st) via GUI

I GUI‑sektionen **Slots** fyller du per slot:

* **Host/IP** (AMCP‑adress), **Port** (standard 5250)
* **Kanal** (Caspar‑channel)
* **Bas‑lager** (aktivt lager, standby = +10)
* **Clip** (filnamn i Caspar‑`media`‑mapp)
* **TC** (start‑timecode, format `HH:MM:SS:FF`, default `00:00:00:00`)

> **Tom host eller tomt clip ⇒ slot ignoreras.**

Klicka **Spara slots** för att skriva ändringarna till `config.json`. Servern skapar/uppdaterar AMCP‑anslutningar för ifyllda slots och rensar ev. gamla.

### Exempel `config.sample.json`

```json
{
  "fps": 50,
  "frames": 30000,
  "autosyncIntervalSec": 10,
  "driftToleran
```
