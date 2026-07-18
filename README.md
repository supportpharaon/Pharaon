# Pharāon — Download website

This repository hosts the **download website** for Pharaon, the memory engine for
students. It is a static site published with GitHub Pages.

**🌐 Live: [supportpharaon.github.io/Pharaon](https://supportpharaon.github.io/Pharaon/)**

## What is Pharaon?

A study calendar that plans itself: a scientific memory engine schedules every review
at the right moment so you never forget what you learn. Free, Windows, 100% local,
no account.

- **[Download the installer](https://github.com/supportpharaon/Pharaon/releases/latest/download/PharaonSetup.zip)** (Windows 10/11) — unzip, run `PharaonSetup.exe`
- **[Portable version](https://github.com/supportpharaon/Pharaon/releases/latest/download/Pharaon-Portable.zip)** — unzip, run `Pharaon.exe`, no installation
- **[Download for Android](https://github.com/supportpharaon/Pharaon/releases/latest/download/Pharaon.apk)** — independent `.apk` app (sideload; allow "install from this source"). Same engine as desktop.
- **iPhone/iPad** — Apple only permits App Store installs: open [the web app](https://supportpharaon.github.io/Pharaon/app/) in Safari → Share → *Add to Home Screen*. Also packaged as [PharaonMobile.zip](https://github.com/supportpharaon/Pharaon/releases/latest/download/PharaonMobile.zip) (self-hostable). Source lives in this repo under [`app/`](app/); the Android domain verification lives at [`supportpharaon.github.io/.well-known/assetlinks.json`](https://supportpharaon.github.io/.well-known/assetlinks.json).

> Shipped as `.zip` because browsers block downloads of unsigned `.exe` files (the
> download never completes and leaves a `.crdownload` file).

## This repository

| File | Purpose |
|---|---|
| `index.html` | The landing / download page |
| `style.css` | Site styles (self-contained, no external requests) |
| `assets/` | Fonts, logo and app screenshots |
| `ENGINE.md` | Full mathematical specification of the scheduling engine |
| `.nojekyll` | Serve files as-is (no Jekyll processing) |

The desktop application's source code lives in a separate project. The compiled
installer and portable executable are published under this repository's
**[Releases](https://github.com/supportpharaon/Pharaon/releases)**, which is where
the download buttons point.

### Publishing

1. **GitHub Pages** → Settings → Pages → *Deploy from a branch* → `main` → **`/ (root)`**.
2. For each app version, create a **Release** tagged `vX.Y.Z` and attach
   `PharaonSetup.zip` and `Pharaon-Portable.zip` (zip the executables — do **not**
   upload bare `.exe` files, browsers refuse to download them). The links always
   resolve to the latest release. Update the two SHA-256 checksums in `index.html`.

## Support

**support.pharaon@gmail.com** · *Built by students, for students.*
