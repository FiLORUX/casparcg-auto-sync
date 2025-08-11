# README.md – Caspar Autosync (20 slots)

**Syfte**
Hålla uppspelning av **upp till 20 förinspelade källor** i fas över en eller flera CasparCG‑servrar, för "låtsas‑live"/utställning där besökare kan klippa i en ATEM i efterhand. Systemet använder **dubbellager** (aktiv/standby) för sömlös **CUT/FADE‑resync** och har tre lägen: **OFF / AUTO / MANUAL**.

> Transparens: Lösningen bygger på dokumenterade mönster i CasparCG/AMCP.

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
  "driftToleranceFrames": 1,
  "resyncMode": "cut",
  "fadeFrames": 2,
  "slots": [
    { "id": 1,  "name": "S01", "host": "", "port": 5250, "channel": 1, "baseLayer": 10, "clip": "", "tc": "00:00:00:00" },
    { "id": 2,  "name": "S02", "host": "", "port": 5250, "channel": 1, "baseLayer": 11, "clip": "", "tc": "00:00:00:00" },
    { "id": 3,  "name": "S03", "host": "", "port": 5250, "channel": 1, "baseLayer": 12, "clip": "", "tc": "00:00:00:00" },
    { "id": 4,  "name": "S04", "host": "", "port": 5250, "channel": 1, "baseLayer": 13, "clip": "", "tc": "00:00:00:00" },
    { "id": 5,  "name": "S05", "host": "", "port": 5250, "channel": 1, "baseLayer": 14, "clip": "", "tc": "00:00:00:00" },
    { "id": 6,  "name": "S06", "host": "", "port": 5250, "channel": 1, "baseLayer": 15, "clip": "", "tc": "00:00:00:00" },
    { "id": 7,  "name": "S07", "host": "", "port": 5250, "channel": 1, "baseLayer": 16, "clip": "", "tc": "00:00:00:00" },
    { "id": 8,  "name": "S08", "host": "", "port": 5250, "channel": 1, "baseLayer": 17, "clip": "", "tc": "00:00:00:00" },
    { "id": 9,  "name": "S09", "host": "", "port": 5250, "channel": 1, "baseLayer": 18, "clip": "", "tc": "00:00:00:00" },
    { "id": 10, "name": "S10", "host": "", "port": 5250, "channel": 1, "baseLayer": 19, "clip": "", "tc": "00:00:00:00" },
    { "id": 11, "name": "S11", "host": "", "port": 5250, "channel": 1, "baseLayer": 20, "clip": "", "tc": "00:00:00:00" },
    { "id": 12, "name": "S12", "host": "", "port": 5250, "channel": 1, "baseLayer": 21, "clip": "", "tc": "00:00:00:00" },
    { "id": 13, "name": "S13", "host": "", "port": 5250, "channel": 1, "baseLayer": 22, "clip": "", "tc": "00:00:00:00" },
    { "id": 14, "name": "S14", "host": "", "port": 5250, "channel": 1, "baseLayer": 23, "clip": "", "tc": "00:00:00:00" },
    { "id": 15, "name": "S15", "host": "", "port": 5250, "channel": 1, "baseLayer": 24, "clip": "", "tc": "00:00:00:00" },
    { "id": 16, "name": "S16", "host": "", "port": 5250, "channel": 1, "baseLayer": 25, "clip": "", "tc": "00:00:00:00" },
    { "id": 17, "name": "S17", "host": "", "port": 5250, "channel": 1, "baseLayer": 26, "clip": "", "tc": "00:00:00:00" },
    { "id": 18, "name": "S18", "host": "", "port": 5250, "channel": 1, "baseLayer": 27, "clip": "", "tc": "00:00:00:00" },
    { "id": 19, "name": "S19", "host": "", "port": 5250, "channel": 1, "baseLayer": 28, "clip": "", "tc": "00:00:00:00" },
    { "id": 20, "name": "S20", "host": "", "port": 5250, "channel": 1, "baseLayer": 29, "clip": "", "tc": "00:00:00:00" }
  ]
}
```

### Timecode → frames

`HH:MM:SS:FF` vid `fps`. Exempel @50 fps: `00:03:24:05` ⇒ `(3*60 + 24)*50 + 5 = 10205` frames.
Systemet räknar **target‑frame per slot** som: `target = (elapsed*fps + tcFrames) % frames`, där `elapsed` är sekunder sedan `t0` (då du tryckte **Start** eller **Start från TC**).

---

## Drift & användning

1. **Fyll slots** och klicka **Spara slots**.
2. **Preload** för att ladda båda lagren i pausat läge.
3. **Start** eller **Start från TC**. (Default: ingen automatisk PLAY sker på serverstart.)
4. **Mode**:

   * **OFF**: ingen autosync; du kan manuellt resynka.
   * **AUTO**: loop som resynkar när |drift| > tolerans, var `autosyncIntervalSec` sekund.
   * **MANUAL**: samma som OFF men tydlig etikett i UI.
5. **Resync nu**: Tvinga resync med valt `CUT/FADE`. FADE använder `fadeFrames` (1–4 typiskt).
6. **Spara (inställningar)** för att uppdatera intervall/tolerans/fps/frames/resync‑läge i farten.

---

## API för Companion/extern styrning

* `POST /api/mode {"mode":"off|auto|manual"}`
* `POST /api/preload` / `POST /api/start` / `POST /api/start-from-tc` / `POST /api/pause`
* `POST /api/resync {"mode":"cut|fade"}`
* `POST /api/settings { autosyncIntervalSec, driftToleranceFrames, fps, frames, resyncMode, fadeFrames }`
* `GET /api/config` → nuvarande config
* `POST /api/config { slots:[...] }` → spara slots (20 objekt)

**Exempel (Companion HTTP action):**

```
URL: http://<server-ip>:8080/api/resync
Method: POST
Body: {"mode":"fade"}
Content-Type: application/json
```

---

## Köra i produktion

* **Som tjänst (NSSM):**

  1. Installera NSSM. 2) `nssm install CasparAutosync` → `Path` = `node.exe`, `Arguments` = `index.js`, `Startup dir` = projektmappen.
  2. Sätt **Log on** och **Restart** policy enligt behov. Starta tjänsten.
* **Task Scheduler:** Skapa ett jobb som startar `npm start` vid inlogg/boot.
* **Reverse proxy (frivilligt):** IIS/NGINX kan terminera SSL och proxya till `localhost:8080`.
* **Loggning:** Om du kör som tjänst, peka NSSM\:s stdout/stderr till en `logs/`‑mapp (finns i `.gitignore`).

---

## Brandvägg & portar

* **8080/TCP**: Webb‑GUI (från kontroll‑datorer).
* **5250/TCP**: CasparCG AMCP (från servern till playout‑burkarna).

---

## Felsökning

* **Current = –**
  Lagret spelar inte (PAUSE) eller din FFmpeg‑build saknar `CALL FRAME`. Testa **Start** igen. Kontrollera kanal/lager.
* **Drift ökar**
  Säkerställ identisk fps & längd på alla klipp, intra‑only media, NTP synk. Sänk intervall eller höj tolerans.
* **Blink vid FADE**
  Öka `fadeFrames` (2–3) eller använd `CUT`. Kontrollera disk/CPU‑headroom.
* **Disconnected**
  Fel IP/port eller brandvägg blockerar 5250. Verifiera att CasparCG kör och svarar på AMCP.

---

## FAQ

**Q: Måste jag använda +10 för standby‑lager?**
A: Nej, men mallen gör det enkelt att manuellt felsöka. Du kan välja andra steg – uppdatera bara `baseLayer`.

**Q: Spelar standby hela tiden?**
A: Nej. Standby är **PAUSE** med **OPACITY=0** och **VOLUME=0** tills resync sker; båda lagren spelar endast under en kort FADE/CUT.

**Q: Startar spelning automatiskt på serverstart?**
A: Nej. Default är **OFF**, och **PLAY** triggas först när du klickar **Start**/**Start från TC**.

**Q: Timecode per slot – måste alla vara lika?**
A: Nej. Du kan ge olika offsets per slot. För för att starta synkrona klipp är det rekommenderade att ange samma TC överallt.
