# Pharāon — Download website

This repository hosts the **download website** for Pharaon, the memory engine for
students. It is a static site published with GitHub Pages.

**🌐 Live: [supportpharaon.github.io/Pharaon](https://supportpharaon.github.io/Pharaon/)**

## What is Pharaon?

A study calendar that plans itself: a scientific memory engine schedules every review
at the right moment so you never forget what you learn. Free, Windows, 100% local,
no account.

- **[Download the installer](https://github.com/supportpharaon/Pharaon/releases/latest/download/PharaonSetup.exe)** (Windows 10/11)
- **[Portable single-file version](https://github.com/supportpharaon/Pharaon/releases/latest/download/Pharaon.exe)** — no installation

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
   `PharaonSetup.exe` and `Pharaon.exe`. The download links always resolve to the
   latest release. Update the two SHA-256 checksums in `index.html` to match.

## Support

**support.pharaon@gmail.com** · *Built by students, for students.*
