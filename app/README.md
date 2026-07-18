# Pharāon Mobile — the memory engine for students, on your phone

The mobile / tablet version of the Pharaon desktop app, delivered as an
**installable offline-first web app (PWA)**.

## The one rule this port follows

**The logic is byte-for-byte the desktop engine.** The files in `backend/`
(`memory.py`, `optimizer.py`, `scheduler.py`, `database.py`, `api.py`…) are exact,
unmodified copies of the desktop app. They run on the phone inside a bundled
Python runtime (Pyodide / WebAssembly), so every scheduling decision — the FSRS
memory model, the optimizer, exam readiness, calibration, catch-ups, pins —
is produced by *the same code* as on desktop.

The UI is also the desktop frontend (`app.js`, `styles.css`, untouched) with an
additive mobile layer:

| File | Role |
|---|---|
| `bridge.js` | Boots Python, exposes `window.pywebview.api` (the exact interface `app.js` expects), guarantees durable persistence to IndexedDB |
| `mobile.css` | ≤900 px: bottom navigation, sheet modals, touch targets; >900 px: the desktop sidebar (tablets) |
| `mobile.js` | The "More" bottom sheet + small platform glue |
| `sw.js` + `manifest.webmanifest` | Full offline support + installability |
| `pyodide/` | Self-hosted Python runtime (no CDN, ~15 MB, cached on install) |

The only platform shim: Windows' "launch at login" (registry) is neutralised at
the boundary in `bridge.js` — it cannot exist inside a browser.

## Data

- Stored **on the device**, in the browser's IndexedDB (no servers, no account).
- Every change is flushed durably before the UI continues; closing or killing
  the app never loses data.
- Daily automatic backups run on launch (same engine feature as desktop), and
  Settings → Data → Export/Import works for moving data between phone and PC.

## Try it on this computer

```
cd "Pharaon mobile"
python -m http.server 8000
# open http://localhost:8000 — resize the window or use devtools device mode
```

## Install it on a phone

PWAs require HTTPS (localhost is exempt). The simplest path:

1. Push this folder to a GitHub repository and enable **GitHub Pages**
   (Settings → Pages → deploy from branch, root).
2. Open the Pages URL on the phone:
   - **Android/Chrome**: menu → *Add to Home screen* → installs like an app.
   - **iPhone/iPad Safari**: Share → *Add to Home Screen*.
3. First launch downloads the runtime (~15 MB) once; after that it works
   fully offline, forever.

Each user's data stays on their own device — hosting the files publicly does
not share anyone's data.

## Verified (automated, mobile emulation)

- Boot on a phone viewport with zero console errors; all ~60 API endpoints answer.
- Engine parity: balanced days, days-off/restrictions honoured, exam readiness,
  memory updates, deterministic replans — same invariants as the desktop battery.
- Real touch flows: first-run tutorial, add topic, complete session with the
  rating sheet, calendar day panel, More sheet, settings.
- Durable persistence across app kills; full offline boot, use and persistence
  with the network disabled.
- Tablet (>900 px) gets the desktop sidebar layout.

Support: **support.pharaon@gmail.com**
