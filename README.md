# FAVA

**A self-hosted, phone-friendly player for your Faba® box backups.**

Drop the content of your Faba box SD card into `asset/`, start the container, and
listen to all your stories and songs from any phone, with search, filters, lyrics
and Chromecast.

> FAVA is an unofficial community project. It is not affiliated with or endorsed by
> Faba / Fabacreative. Use it only with backups of content you own, and don't
> redistribute the audio files.

## Features

- **Plays the original `.MKI` files directly.** They are decoded on the fly while
  streaming (seeking works too), so you don't need a decrypted copy on disk.
- **Automatic catalogue.** Album titles, track titles, categories, languages,
  credits, lyrics and the figure picture are collected from every source available
  (see [Metadata sources](#metadata-sources)).
- **Verification.** Every track is checked: valid MPEG stream, duration, missing
  `CPxx` files, MKI vs MP3 copies that differ. Booklets are checked too:
  - a PDF filed under the wrong figure is detected;
  - when the very same file appears under several figures, only the album whose
    title matches the booklet's content uses it.
- **Duplicates.** Albums with the same recording, sold as figures for different
  languages, are detected through an audio fingerprint that ignores ID3 tags. They
  are linked to each other and hidden from Home and Library by default.
- **Spotify-style mobile UI.** Mini player, full-screen player, ±15 s skip, speed,
  **sleep timer with fade-out**, resume where you left off, favourites, lyrics view,
  queue, and lock-screen controls through the Media Session API. Installable as a
  PWA.
- **Profiles**, Netflix-style ("Chi ascolta?"). Each profile has its own
  favourites and resume positions. The avatar is a stylised face or any figure
  from your library, on a colour of your choice. The active profile is remembered
  per device.
- **Per-profile languages.** A profile can be limited to some languages; Home,
  Library, search and counts follow it.
- **Online details.** Description, age range and contents come from the matched
  product page. Track titles are filled in only when the product lists exactly
  one title per track (checked against the MP3 names: about 95% match), or as
  "Story · parte N" for single-story albums.
- **Password protection.** A family password to use the app, plus an optional
  parents' password for management.
- **Uploads from the browser.** A folder, files or a ZIP of backups, plus a
  manual cover per album.
- **Offline listening.** Download albums to the phone (needs HTTPS). The app
  shell, album pages and audio then work without network, seeking included.
- **Search** across album and track titles, voices/authors and lyrics, with accents
  ignored. **Filters** for category (stories, songs, rhymes, learning), language,
  series (Disney, PAW Patrol…), favourites and albums with lyrics.
- **Chromecast** through the Google Cast Default Media Receiver, with the Remote
  Playback API as a fallback.
- An option to skip the short Faba intro and outro jingles.
- **NFC cards and Easy mode.** Pair any NFC card with an album or audiobook,
  then hold the card to the phone and it plays. Easy mode, turned on per
  profile, is a full-screen view for small kids with a few big buttons, handy on
  a dedicated Android phone (see
  [NFC cards and Easy mode](#nfc-cards-and-easy-mode)).
- **Audiobooks**, in their own section. Drop in `.m4b` files (or folders of
  `.mp3` / `.m4a`), or upload them from the browser. Chapters, author, narrator
  and cover are read from the files. Each book remembers its own speed (up to 2×).
  The player moves chapter by chapter, skips ±30 s, saves bookmarks with notes and
  has a sleep timer at the end of the chapter. Books can be marked as for kids or adults, and each profile
  sees all of them, only the kids' ones, or none (see [Audiobooks](#audiobooks)).

## Install on a NAS or home server (prebuilt image)

A ready-made image for x86-64 and ARM64 (Raspberry Pi 4/5, most recent NAS) is
published at `ghcr.io/leouzz/fava`. You need Docker with the compose plugin.

```bash
mkdir -p /srv/fava && cd /srv/fava
base=https://raw.githubusercontent.com/leouzz/fava/main/deploy
curl -fsSLO $base/docker-compose.yml
curl -fsSLO $base/Caddyfile
curl -fsSL  $base/.env.example -o .env     # then edit .env: passwords, LAN address, PUID/PGID
mkdir -p asset data                        # copy your backups into ./asset (see below)
sudo chown -R "$(id -u):$(id -g)" data     # data must be writable by PUID:PGID
docker compose up -d                       # HTTPS as well: docker compose --profile https up -d
```

Open `http://<nas-ip>:8080` on your phone. The first start imports the library
automatically. You can import again at any time from **Gestione → Avvia import**,
or upload new backups from **Gestione → Carica backup**.

To update to the latest version, run `docker compose pull && docker compose up -d`.

**Moving an existing installation.** Copy the `data/` folder along with `asset/`.
It holds the database, covers, the online-catalogue cache, profiles and
favourites. Because the paths inside the container stay the same (`/assets`,
`/data`), nothing has to be re-imported.

## Build from source

```bash
git clone https://github.com/leouzz/fava.git && cd fava
# copy your backup into ./asset (see below), then:
docker compose up -d --build
```

## The `asset/` folder

FAVA scans `asset/` recursively. Only the MKI dump is required; everything else
adds metadata.

```
asset/
├── MKI/                      # Faba box SD card dump (required)
│   ├── K0010/
│   │   ├── CP01.MKI          # the .MKI extension is optional
│   │   └── CP02.MKI
│   └── K0011/…
├── MP3/                      # decoded copies with real names (optional)
│   ├── 0010 - Il mondo secondo Tea!/
│   │   ├── 00 - Intro Faba.mp3
│   │   ├── 01 - Track title.mp3
│   │   └── ZZ - Outro Faba.mp3
│   └── list.csv              # "0010,Album title" lines, UTF-8 or UTF-16
└── PDF/                      # official booklets (optional)
    ├── K10 - Il mondo secondo Tea! - Documento.pdf   # credits + figure picture
    ├── K106 - America Latina in musica - Testi.pdf   # tracklist + lyrics
    └── K104 - Storie della buonanotte - Attivita.pdf # activity sheets
```

The folder names (`MKI`, `MP3`, `PDF`) don't matter. FAVA recognises files by
their naming patterns.

- `Kxxxx` is the 4-digit figure ID. It is the same number the NFC tag carries.
- `CPnn` files are the tracks, in playback order.
- In the MP3 folders, files are paired with the `CPnn` files **by position**:
  sorted file *n* corresponds to `CP{n}`.

## Audiobooks

Audiobooks live in their own section (**Audiolibri**), separate from the Faba
library. FAVA reads them from:

- `asset/audiobooks/` (or `asset/audiolibri/`), at any depth;
- the folder set in `FAVA_AUDIOBOOK_DIR`, if you already have a library elsewhere;
- **Gestione → Carica audiolibri**, which uploads `.m4b` / `.m4a` / `.mp3` files,
  folders or a ZIP to `data/audiobooks/`.

```
asset/audiobooks/
├── bambini/                          # "bambini", "kids", "ragazzi"… → for kids
│   └── Il piccolo principe.m4b       # one file = one book, chapters inside
├── adulti/                           # "adulti", "adults" → for adults
│   └── Autore - Titolo/              # a folder of MP3 / M4A = one book,
│       ├── 01.mp3                    # one file per chapter
│       ├── 02.mp3
│       └── cover.jpg                 # used when the files have no cover
└── Altro libro.m4b                   # no hint: the audience is left unset
```

- **Grouping.** Each `.m4b` file is a book. The exception is a book split into
  parts: several files in the same folder with the same album tag become one
  book. Within a folder, `.mp3` / `.m4a` files form one book, ordered by track
  number or by name.
- **Metadata.** The title, author (artist / album artist), narrator (composer, or a
  `narrator` tag), description, genre and cover come from the tags. When the tags
  are missing, FAVA uses file and folder names; for example, `Author - Title`
  gives both the author and the title.
- **Chapters.** FAVA reads the QuickTime chapter track of M4B files, falling back
  to the Nero `chpl` atom, and the ID3 `CHAP` frames of MP3s. The player's seek
  bar covers the current chapter, and ⏮ / ⏭ jump between chapters.
- **Kids or adults.** The audience comes from the folder name or a children's
  genre tag. Parents can change it on the book page ("Adatto a"), and their choice
  survives re-imports. In the profile editor, **Audiolibri** can be set to *Tutti*,
  *Solo per bambini* (books marked as for kids only) or *Nascosti* (no section at
  all).
- **Progress.** Progress is saved per profile. A book counts as finished when you
  reach the end, and finished books leave "Continua ad ascoltare". The book page
  has "Segna come finito" and "Segna come da iniziare". Each book keeps its own
  playback speed on the device.
- **Online details.** For books missing a cover, description or author, the import
  searches Apple Books (the public iTunes Search API) and Open Library. Only the
  title and author are sent. A near-identical title *and* author is applied
  automatically. Less certain matches wait in **Gestione → Copertine trovate
  online**, where you confirm or discard them, and "Non è lei" undoes an automatic
  one. Online data only fills what the files lack: tags always win. A children's
  genre (e.g. "Bambini e ragazzi") marks the book as for kids, unless you already
  set it. On the book page, **Cerca online** lets you pick the right result
  yourself, or search with your own words. **Togli dati online** removes what was
  filled and stops looking for that book. Decisions survive re-imports, and
  answers and images are cached in `data/catalog` for 30 days. Turn it off with
  `FAVA_ONLINE_COVERS=0` (covers) and `FAVA_ONLINE_DETAILS=0` (descriptions,
  authors).
- **Bookmarks.** Tap the bookmark button in the full-screen player to save the point
  being played. Bookmarks are listed with a note, which you can edit, both in the
  player (Capitoli → Segnalibri) and on the book page. They belong to a profile and
  survive re-imports.

## Metadata sources

| Data           | Priority (first match wins) |
| -------------- | --------------------------- |
| Album title    | MP3 folder name → `list.csv` → community registry → PDF file name → booklet title |
| Track title    | MP3 file name (unless it's a generic `Traccia N`) → booklet tracklist → `Traccia N` |
| Category       | Registry SKU digit (`FFR1…` stories, `FFR2…` rhymes, `FFR3…` music, `FFR4…` learning) → booklet subtitle → keywords in the title → median track duration |
| Language       | Booklet subtitle → registry → stop-word detection on the titles |
| Cover          | `asset/covers/` → `Documento` booklet picture → official online catalogue → retailers (see below) |
| Credits        | `Documento` booklet (text, voices, music, sound design…) |
| Lyrics         | `Testi` booklet, matched to tracks by title |
| Intro / outro  | Named `Intro/Outro Faba`, or short tracks beyond the booklet tracklist |

The community registry is
[`TAGS.md` from myfaba-hacks](https://github.com/wansors/myfaba-hacks/blob/main/TAGS.md).
It is downloaded at import time and cached in `data/`. Set `FAVA_REGISTRY_URL=""`
to work fully offline.

**Online covers.** For albums without a booklet picture, FAVA looks the figure up in
the official myfaba stores (`.it`, `.es`, `.fr`). It picks candidates from each
store's product sitemap and accepts a product only when its **SKU** equals the
registry SKU. Without a SKU, it needs a near-identical name in the album's language.
The white studio background is removed so the photo matches the booklet covers.
Pages and images are fetched once, slowly, and cached in `data/catalog`; they stay
on your server and are never committed or redistributed. Disable this with
`FAVA_ONLINE_COVERS=0`.

**Retired figures.** Figures that are no longer sold are looked up in retailer
product sitemaps (default: italiano-bello.com, set with `FAVA_RETAILER_SITEMAPS`).
Only the sitemap is read; it already lists every product's images. Two outcomes:

- A near-identical name with a white-background photo, not claimed by another
  album, is applied automatically.
- Anything less certain goes to **Gestione → Copertine trovate online**, where you
  confirm it (✓) or discard it (✗).

Automatic covers can be undone there too ("Non è lei"). Decisions are remembered
across imports.

**Manual covers.** Put `asset/covers/K0010.png` (or `0010.jpg`, `.webp`) to force a
picture for any album. Manual covers always win.

Parsed booklets and audio probes are cached by file size and mtime, so re-imports
take seconds.

## The MKI format

An `.MKI` file is a normal MP3 with every byte remapped through a fixed
substitution table chosen by `position mod 4`. Decoding is a lookup that can start
at any offset, which is what allows range requests and seeking while streaming.
See [`backend/fava/mki.py`](backend/fava/mki.py). The mapping was documented by the
[myfaba-hacks](https://github.com/wansors/myfaba-hacks) project.

## Chromecast

The Cast button appears in the full-screen player. It needs:

1. **Chrome** on Android or desktop. iOS and Safari have no Cast SDK; they can use
   AirPlay through the Remote Playback fallback where it's available.
2. **A secure context.** Chrome only enables Cast on HTTPS (or `localhost`). The
   compose file includes an optional Caddy proxy:
   `docker compose --profile https up -d`, then open `https://<server-ip>:8443`.
3. **A media URL the Chromecast can reach.** The Chromecast downloads the audio
   itself, so set `FAVA_PUBLIC_URL=http://<server-lan-ip>:8080`.

## Passwords

Copy `.env.example` to `.env` and set:

- `FAVA_PASSWORD`: everyone at home uses this one. Without it, the app shows a
  login screen to anyone.
- `FAVA_ADMIN_PASSWORD` (optional): unlocks import, uploads, profile management
  and cover review. Kids can listen and add favourites, but can't change anything.
  Without it, the family password unlocks everything.

Sessions are signed cookies valid for 180 days. Wrong passwords are throttled per
IP. Media URLs given to the Chromecast carry a signed key instead of the cookie.
The signing secret is generated in `data/secret.key`, or set `FAVA_SECRET`. Set
a password **before** exposing FAVA outside your home network, and put it behind
HTTPS.

## Uploading backups

**Gestione → Carica backup** accepts a whole folder (on desktop), single files,
or a ZIP containing `K0010/CP01.MKI`-style folders, MP3s and PDFs. Files are
streamed to `data/uploads/` (the `asset` mount stays read-only), ZIPs are
extracted safely, and an import starts automatically. Uploaded batches can be
deleted from the same page. A cover can be replaced from the album page
("Cambia copertina"); it is stored in `data/covers-manual/`.

## Offline listening

Tap ⤓ on an album page to store its audio on the device. A service worker then
serves it, with range requests, so seeking works offline. Album pages, covers
and the app itself are cached too. Browsers only allow this on **HTTPS** (or
`localhost`): use the Caddy profile below, or any HTTPS reverse proxy. Downloads
can be removed from the album page or from Gestione, which also shows the
storage used.

## NFC cards and Easy mode

Hold a card to the phone and its album starts, like a figure on the Faba box.

**What you need**

- An Android phone with NFC, running **Chrome**. Web NFC does not exist on iPhone
  or in Firefox, Samsung Internet or desktop browsers.
- FAVA opened over **HTTPS** (the Caddy profile or any reverse proxy), because
  Chrome only offers NFC to secure pages.
- Cards with an **NTAG** chip (NTAG213/215/216) or another NFC Forum tag. Cards
  sold as "Mifare Classic", "S50" or "13.56 MHz 1K" only work on phones with an NXP
  NFC chip. On the others Chrome reports them as unreadable and FAVA says so. The
  cards are recognised by their serial number, so nothing is written on them and
  they can stay blank.

**Pairing** (parents' password). Go to **Gestione → Tessere NFC → Associa**, hold
a card to the phone and pick the album. "Associa un'altra" pairs a whole pile in
a row. You can also tap the NFC button on an album or audiobook page and then
hold the card. A card can be moved to another album at any time, and several
cards can start the same album. Pairings live in `data/user.db`, so a re-import
keeps them.

**Easy mode** is a profile setting: in **Chi ascolta? → Gestisci profili**, edit the
kid's profile and turn on *Modalità Easy* (parents' password). While that profile
is active the phone shows Easy mode, across reloads and restarts too.

- After every start, one tap on "Tocca per iniziare" is needed: Chrome asks for
  it before allowing NFC and sound.
- Holding a card plays its album from where this profile left off (from the top
  once it was finished). The same card resumes a paused album; another card
  switches album. **Dall'inizio** restarts the album from the first track.
- The only other controls are previous, play/pause and next. The screen is kept
  on, and the Android back gesture is ignored.
- To leave, hold the lock in the top corner for 2 seconds, then enter the
  parents' password (or answer a multiplication when FAVA has no passwords).
  *Chi ascolta?* opens: choose a profile without Easy mode.
- Without NFC (desktop, iPhone, plain HTTP) Easy mode shows the paired albums as
  big tiles to tap, which is handy for trying it out.

**A dedicated phone.** Install FAVA as an app from Chrome's menu and choose the
kid's profile (with Easy mode on). Then, in Android settings, enable **App pinning**
(Security → *Pin app* / *Screen pinning*) and pin FAVA, so the kid can't leave it.
Keep the phone on the charger. Web NFC only reads while the screen is on and
FAVA is in the foreground, which Easy mode takes care of. Albums downloaded for
offline listening also play from cards without network.

## Configuration

| Variable               | Default            | Description |
| ---------------------- | ------------------ | ----------- |
| `FAVA_ASSET_DIR`       | `/assets`          | Folder with the backups (mounted read-only) |
| `FAVA_DATA_DIR`        | `/data`            | SQLite database, covers and cache |
| `FAVA_PUBLIC_URL`      | *(browser origin)* | Base URL the Chromecast uses for media |
| `FAVA_IMPORT_ON_START` | `auto`             | `auto` (first start, or when the asset path changes), `always`, `never` |
| `FAVA_PREFER`          | `mki`              | Stream the original MKI files or the MP3 copies |
| `FAVA_REGISTRY_URL`    | myfaba-hacks `TAGS.md` | Empty string disables the registry |
| `FAVA_COVERS`          | `1`                | `0` skips cover extraction from booklets |
| `FAVA_ONLINE_COVERS`   | `1`                | `0` disables the online catalogue lookup (Faba covers, audiobook covers) |
| `FAVA_CATALOG_STORES`  | myfaba `.it,.es,.fr` | Comma-separated store base URLs |
| `FAVA_RETAILER_SITEMAPS` | italiano-bello.com | Comma-separated retailer sitemap URLs; empty disables |
| `FAVA_PASSWORD`        | *(empty)*          | Family password (empty = open access) |
| `FAVA_ADMIN_PASSWORD`  | *(empty)*          | Parents' password for management actions |
| `FAVA_SECRET`          | *(generated)*      | Cookie/media-key signing secret (`data/secret.key`) |
| `FAVA_ONLINE_DETAILS`  | `1`                | `0` disables descriptions / track titles from product pages, audiobook descriptions and authors |
| `FAVA_AUDIOBOOK_DIR`   | *(empty)*          | Extra audiobook folder, besides `asset/audiobooks` and the uploads |
| `PORT`                 | `8080`             | HTTP port |

## Development

```bash
# backend (Python 3.11+)
cd backend
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
FAVA_ASSET_DIR=../asset FAVA_DATA_DIR=../data python -m fava   # http://localhost:8080
python -m fava.importer                                        # import from the CLI

# frontend (Node 20+), in another terminal
cd frontend
npm install
npm run dev     # http://localhost:5173, proxies /api to :8080
```

Stack: FastAPI + SQLite (FTS5) + mutagen + pdfplumber/pypdfium2 on the backend;
React + Vite + Tailwind with shadcn-style components (Radix, vaul) + TanStack
Query + zustand on the frontend.

### API

| Endpoint | Purpose |
| -------- | ------- |
| `GET /api/albums?q=&category=&language=&series=&favorites=&lyrics=&sort=&kind=&audience=` | List and filter albums (`kind=audiobook` for audiobooks, default `faba`) |
| `GET /api/albums/{id}` | Album with tracks, booklets, issues and resume position |
| `GET /api/search?q=` | Full-text search (albums, tracks, lyrics, credits) |
| `GET /api/stream/{track_id}` | Audio stream with HTTP Range support |
| `GET /api/facets` | Categories, languages, series and stats |
| `POST /api/import`, `GET /api/import/status` | Start an import and follow its progress |
| `GET /api/issues` | Verification report |
| `GET /api/nfc/tags`, `PUT /api/nfc/tags/{uid}` `{album_id}`, `DELETE /api/nfc/tags/{uid}` | NFC card pairings (changes need the parents' password) |
