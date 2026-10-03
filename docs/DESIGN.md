# WATTS Voice — design notes

## What WATTS does today (reference)

WATTS (`JaredVogler2/WATTS`) is a Flask app for the industrial-engineering
time-standard lifecycle at 787 production. Its *Perform Time Study* page
(`templates/perform_study.html`) is a FLAPS-style tap-to-time grid:

- 9 categories × 8 tasks, each fixed to a lean type: **VA**, **NVAN**
  (necessary), **NVAW** (waste: handling/rework) or **NVAD** (delay).
- Tapping a task ends the previous one.
- Pause excludes time.
- There are two undo variants.
- Mechanics are tracked with roles and 80/100/120 ratings.

A completed study is posted to `/api/save-full-time-study` as
`{study, elements, mechanics}`. It then becomes evidence: 3 approved pieces,
including at least 1 time study, unlock a standard revision.

WATTS Voice replaces the *tapping* with *narration*. It keeps the data model
WATTS already aggregates on, so voice studies sit next to tap studies.

## Task1 requirements → implementation

| Task1 asks for | Where |
|---|---|
| Voice-based element selection; analyst narrates key actions | `js/speech.js` (iOS Safari speech recognition, server fallback), `handleUtterance` in `js/app.js` |
| Voice → text → LLM (or voice → LLM) | Speech-to-text on the phone, then `/api/interpret` (Claude or BCAI) for anything the on-device matcher can't place. See "Voice direct to LLM" below |
| Map actions to **standardized** elements ("sealing" vs "sealant work") | `server/catalog.json` (WATTS names, stable codes, aliases); `js/matcher.js`; LLM output restricted by JSON-schema `enum` and re-validated in `normalize_decision`. Review shows **standard element totals** |
| Pictures throughout the study | Live in-page viewfinder (`js/camera.js`), shutter time exact, "photo" voice command; native-camera fallback with EXIF time; post-study photo import placed by EXIF time |
| Video-editor-like timeline / Gantt, color-coded VA, NVA-necessary, NVA waste/rework, NVA delay | `js/timeline.js`: Track mode (clip lane) and Gantt mode (row per element); colors from the catalog's `leanTypes` |
| Photos on the timeline with the action at that moment | Photo track with stems into the element lane; photo viewer shows the element running at that time and the narration around it |
| Continuous timer from study start | `model.js` keeps one study clock; elements are boundaries on it; pauses excluded from durations |
| Web app on Posit and Vercel | Single Flask app (`app.py`), `vercel.json`, `scripts/deploy_posit.sh`, all client URLs relative (Posit serves under `/content/<guid>/`) |
| Safari (iPhone) first; Edge/Firefox/Chrome nice-to-have | iPhone-first layout (portrait, landscape), iOS quirks handled (see below); Chrome/Edge use their Web Speech; browsers without it can use server transcription |

## Key decisions

**Speech-to-text, then a constrained LLM, not free-form LLM output.** Studies
are compared by element code later, so the LLM never names an element. It
picks a code from an `enum` of the 72 catalog IDs (Claude structured outputs).
The server then re-checks the answer. Unknown codes become "unclear", and
"Other" requires a short description and is flagged for review.

**Local first, AI second.** Most narration is short and literal ("drilling",
"torque check"). The on-device matcher resolves it in under 1 ms with no
network, no cost and no data leaving the phone. The AI is called only when
the matcher is unsure. A setting can send every phrase to the AI for a second
opinion.

**Timing comes from speech onset, never from the AI.** Each utterance records
when the analyst started speaking, minus a configurable latency compensation.
For push-to-talk it is the press time; for typed narration it is when typing
started. Elements are stored as boundaries on the study clock. A late AI
answer therefore inserts or updates a boundary at the right moment. The same
mechanism handles corrections, deletes ("time goes back to the previous
element") and nudges.

**Same element = continuation.** Saying "applying sealant" during
`ASM-05 Fay Surface Sealing` does not create a new element. Adjacent
duplicates always merge.

**Photos stay on the phone.** They are JPEG blobs in IndexedDB with 320-px
thumbnails for the timeline, and they leave the device only in an export.
The live viewfinder captures a frame at the shutter press, so the timestamp
is exact and speech keeps running. The native camera is a fallback.

All photos are baseline JPEG, never HEIC. File inputs ask iOS for
`image/jpeg`, and every image is re-encoded through a canvas, so anything
Safari can decode comes out as `.jpg`. The end-to-end test checks the JPEG
signature of every exported photo.

**No build step, no front-end dependencies.** Plain ES modules work in Safari
16.4+. ZIP, EXIF and WAV handling are small local modules, so the app shell
works offline through the service worker.

## iPhone / Safari specifics handled

- The microphone and camera are started synchronously inside the
  *Begin study* / *Resume* tap, because iOS grants them only to a user
  gesture.
- `continuous` recognition on iOS can stop after silence and sometimes never
  marks results final. The engine auto-restarts with back-off and treats
  interim text that has stopped changing for 1.3 s as final. When iOS appends
  to an already-emitted result, only the new words are emitted, timed from
  when they started.
- The camera requests **video only**, so it does not compete with speech
  recognition for the microphone. `playsinline` is set on the video.
- `navigator.wakeLock` keeps the screen on and is re-acquired when the app
  returns to the foreground.
- Time the app spent in the background or closed is recorded as a
  *coverage gap* on the timeline. The running element continues, because the
  mechanic kept working.
- Safari can reload a tab at any time, so every change is persisted
  immediately. Reopening offers **Resume study**.
- 16-px inputs (no zoom-on-focus), safe-area insets, `100dvh`, and no
  long-press callout on push-to-talk.
- After the keyboard closes, the live screen scrolls back so the current
  element is on top.
- Photos go to teammates through the share sheet. **Save study folder**
  produces `LINE_SOI.zip`; Files turns it into the `LINE_SOI` folder.
  **Email photos** shares the individual
  `LINE_SOI_<element #>_<element>.jpg` files with Mail, Outlook or Teams,
  shrunk if they would exceed about 18 MB. A web page cannot write into
  Files or Photos without this step. If preparing the files takes so long
  that iOS no longer counts it as the original tap, a "ready — Share" toast
  asks for one more tap.
- Safari may clear a website's storage after 7 days without use. Home
  Screen apps are exempt, so the app asks Safari-tab users to add it to the
  Home Screen and flags studies whose photos were never saved off the
  phone.
- Other exports use the share sheet (AirDrop / Files / Teams) via
  `navigator.share`, falling back to a download.

## iPhone validation checklist

The automated end-to-end test runs Chromium at iPhone size with a scripted
recognizer. Before rollout, verify on physical, company-managed iPhones:

1. Speech recognition starts from *Begin study* and keeps listening for 10+
   minutes. Check with the phone on battery and in Low Power Mode.
2. Speech recognition and the live camera run at the same time. Check that
   the "photo" command fires the shutter while listening.
3. Siri/Dictation policy on managed devices. If it is blocked, configure
   `STT_API_KEY` and switch the engine to server transcription.
4. The screen stays awake for a 60-minute study, and the battery drain is
   acceptable.
5. Speech resumes after a phone call or app switch (coverage gap shown).
6. Recognition accuracy for plant vocabulary (Hi-Lok, cleco, fay seal, NDI) in
   floor noise. Compare continuous listening with push-to-talk.
7. Home-screen (standalone) mode vs a Safari tab: whether speech recognition
   is available in both on your iOS version.
8. Export the package and open `report.html` from Files.

## Not done yet / next steps

- **WATTS import.** WATTS has no endpoint that accepts the export yet.
  `watts_import.json` is shaped for `/api/save-full-time-study`
  (`time_study_type: "VOICE"`, extra provenance keys ignored), so an upload
  button in WATTS's Submit Evidence page is a small change there. Time study
  IDs are provisional (`TSV-…`); WATTS should assign `TS-SOI-LINE-NNNN` on
  import.
- **SOI / analyst lookups.** WATTS resolves SOI, line and BEMSID through
  Teradata/SQL Server. WATTS Voice has no access to those, so the fields are
  typed in.
- **Voice direct to LLM.** A speech-native model (e.g. a realtime audio model
  whose tool calls are restricted to the catalog codes) could replace the
  speech-to-text step. It is worth evaluating against floor noise once the
  STT → LLM baseline has been measured on devices.
- **Catalog governance.** `server/catalog.json` mirrors WATTS's hard-coded list
  (`tests/test_api.py` fails if they drift). If WATTS moves its catalog to a
  table, serve it from there.
- **Automatic team upload.** Photos could go straight to a team SharePoint
  or OneDrive folder (Microsoft Graph) instead of through the share sheet.
  That needs an Azure AD app registration and IT approval.
- **Partial-assist timing.** Partial assist is entered as minutes at setup,
  not tracked live as in WATTS.
