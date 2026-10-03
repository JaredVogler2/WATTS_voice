# WATTS Voice

Voice-narrated time studies for iPhone. This is the next generation of the
[WATTS](https://github.com/JaredVogler2/WATTS) *Perform Time Study* tap-to-time
module.

The analyst watches the mechanic and **says what is happening** ("he's drilling
the pilot holes", "now waiting on QA"). WATTS Voice:

- **Standardizes the narration.** Each phrase maps onto the WATTS standard
  element list (the same 9 categories × 8 elements and VA / NVAN / NVAW / NVAD
  lean types), so "sealing", "sealant work" and "applying sealant" all become
  `ASM-05 Fay Surface Sealing`.
- **Captures photos on the study clock.** Say "photo", or tap the shutter. Each
  photo is pinned to the exact moment it was taken and to the element running
  then.
- **Builds the timeline as you go.** A video-editor style track with
  color-coded bars by lean type, the photo track above it, pauses hatched, and
  a Gantt mode with one row per element.
- **Exports for WATTS.** A package of JSON, CSV, photos and an offline HTML
  report. Its `watts_import.json` uses the exact payload of WATTS
  `POST /api/save-full-time-study`.

> Task spec: [`Task1`](Task1) · design notes and requirement mapping: [`docs/DESIGN.md`](docs/DESIGN.md)

## Using it on an iPhone

1. Open the deployed URL in **Safari** (it must be HTTPS). Optionally use
   *Share › Add to Home Screen*.
2. Run **Device check** once: allow the microphone and camera.
   - Speech uses iOS's built-in recognition, so **Siri & Dictation must be
     enabled**: *Settings › General › Keyboard › Enable Dictation*.
   - Company-managed iPhones that block Siri also block this. Use
     *Settings › Voice engine › Server transcription* there.
3. Fill in SOI / Line (and the job description, which helps the AI) and tap
   **Begin study**. This starts the clock, the microphone and the camera.
4. Narrate. Spoken commands must be the whole phrase, optionally prefixed with
   "Watts":

| Say | Does |
|---|---|
| "photo" / "take a picture of the gap" | snaps a photo (with caption) |
| "pause" / "resume" | pauses timing (paused time is excluded, as in WATTS) |
| "scratch that" / "undo" | removes the last element |
| "note: the bit looks dull" | adds a note to the timeline without changing the element |
| "end the study" | opens the Complete dialog |

Typing in the narration box works too, including the keyboard's own dictation
mic. So does tapping **☰ Elements**. Tap any bar, narration line or photo to
correct it. Corrections include changing the element, nudging the start time,
inserting or deleting an element, or picking one of the AI's alternatives.

## How mapping works

1. **On-device matcher** (`public/js/matcher.js`). It returns a result
   instantly and works offline, using the catalog's names and aliases with
   fuzzy matching. Clear phrases are applied immediately.
2. **AI (optional).** Unclear phrases go to `POST /api/interpret`. The server
   asks the LLM for structured JSON whose `element_id` is restricted to the
   catalog codes, then validates the answer again (`server/interpret.py`), so
   free-text element names can never enter a study.
3. **Timing.** The element starts when the analyst *started speaking*, not
   when the text or the AI answer arrived. A late AI answer is inserted
   retroactively at the right time.

Low-confidence mappings are flagged **⚑ review** and listed on the review
screen.

## Run locally

```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
flask --app app run --debug          # http://127.0.0.1:5000
```

The microphone and camera need HTTPS on a phone. To try it on an iPhone
before deploying, put it behind an HTTPS tunnel (e.g. `cloudflared tunnel
--url http://localhost:5000`).

## Configuration (environment variables)

| Variable | Purpose |
|---|---|
| `LLM_PROVIDER` | `auto` (default), `anthropic`, `bcai` or `none` |
| `ANTHROPIC_API_KEY` | Claude for element mapping (`ANTHROPIC_MODEL` defaults to `claude-opus-5-5`, `ANTHROPIC_EFFORT` to `low`) |
| `BCAI_PAT` (+ `BCAI_API_URL`, `BCAI_MODEL`, `BCAI_CA_BUNDLE`) | Boeing BCAI, same pattern as WATTS `bcai_client.py`, for deployments inside the Boeing network |
| `STT_API_KEY` (+ `STT_BASE_URL`, `STT_MODEL`) | Optional OpenAI-compatible transcription, for phones where Siri/Dictation is blocked |
| `APP_ACCESS_CODE` | Optional shared code required by `/api/interpret` and `/api/transcribe` (enter it in the app's Settings) |

With no LLM configured, the app still works: the on-device matcher maps clear
narration, and everything else is flagged for a tap-to-assign.

## Deploy

**Vercel.** Import the repo; the Flask preset finds `app.py`. `public/` is
served from the CDN, and `vercel.json` sets the function limits and the
camera/microphone `Permissions-Policy`. Add the environment variables in
*Project › Settings › Environment Variables*.

**Posit Connect.** `scripts/deploy_posit.sh` runs
`rsconnect deploy flask --entrypoint app:app`. Connect serves the app under
`/content/<guid>/`, and every URL in the client is relative, so no extra
configuration is needed. Set the variables in the content's *Vars* panel.

Python ≥ 3.10 is required (the Anthropic SDK 1.x).

## Data handling

- Studies and photos are stored **only on the phone** (IndexedDB) until
  exported. Photos are never uploaded.
- **Every photo is a standard JPEG (`.jpg`).** Viewfinder shots are encoded
  as JPEG in the page. Native-camera and imported photos are requested as
  JPEG and re-encoded on the phone anyway. iPhone HEIC never reaches the
  study or the export.
- Only the narration *text* (plus the current element and the job
  description) is sent to the configured LLM, and only for phrases the
  on-device matcher can't place.
- Shop-floor narration may be Boeing proprietary or export-controlled. Use an
  approved endpoint (e.g. BCAI on an internal Posit Connect) for production
  data. A public Vercel deployment with an external LLM is for demos with
  non-sensitive data unless your program approves it.

## Tests

```bash
python -m pytest -q                       # API, catalog-vs-WATTS check, LLM guardrails (mocked)
node --test tests/js/*.test.mjs           # matcher, study model, zip, EXIF, WAV
node tests/e2e/iphone_flow.cjs http://127.0.0.1:5000/   # Playwright, iPhone viewport, scripted speech
```

The end-to-end test drives a full study at iPhone size. It uses a fake camera
and a scripted stand-in for Safari's speech recognizer, including results that
never become "final", which iOS sometimes produces. **It is not a substitute
for testing on a physical iPhone.** See the checklist in
[`docs/DESIGN.md`](docs/DESIGN.md#iphone-validation-checklist).

## Layout

```
app.py                 Flask entry (Vercel, Posit Connect, local)
server/catalog.json    Standard element catalog (WATTS names + codes + voice aliases)
server/interpret.py    Prompt, JSON schema, validation of AI decisions
server/llm_anthropic.py / llm_bcai.py / stt.py   Providers
public/                The web app (no build step): index.html, css/, js/
  js/model.js          Study model: boundaries, pauses, totals, WATTS payload
  js/matcher.js        On-device matcher + spoken commands
  js/speech.js         iOS/Safari speech engine + server-transcription engine
  js/camera.js         Live viewfinder capture, native fallback, EXIF times
  js/timeline.js       Track / Gantt timeline with photo track
  js/export.js, zip.js Package, CSV, WATTS JSON, offline report
tests/                 pytest, node unit tests, Playwright e2e
```
