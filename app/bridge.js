/* ═══════════════════════════════════════════════════════════════
   PHARAON MOBILE — Python bridge
   Boots the REAL desktop backend (memory / optimizer / scheduler /
   database / api — byte-identical files) inside Pyodide (WebAssembly)
   and exposes it as window.pywebview.api, the exact interface app.js
   already talks to. Data persists in the browser via IndexedDB.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const BACKEND_FILES = ['__init__', 'version', 'autostart', 'memory',
                         'database', 'optimizer', 'scheduler', 'api'];
  const DATA_DIR = '/data';

  // ── Splash helpers ─────────────────────────────────────────────
  function splash(msg, pct) {
    const el = document.getElementById('pySplashMsg');
    const bar = document.getElementById('pySplashBar');
    if (el) el.textContent = msg;
    if (bar && pct != null) bar.style.width = pct + '%';
  }
  function splashError(msg) {
    const box = document.getElementById('pySplash');
    if (!box) return;
    box.innerHTML = '<div class="splash-card"><div style="font-size:26px">⚠️</div>' +
      '<div class="splash-title">Could not start the engine</div>' +
      '<div class="splash-msg">' + msg + '</div>' +
      '<button onclick="location.reload()" class="splash-btn">Retry</button></div>';
  }
  function hideSplash() {
    const box = document.getElementById('pySplash');
    if (box) { box.style.opacity = '0'; setTimeout(() => box.remove(), 350); }
  }

  // ── Persistence: flush the in-memory FS to IndexedDB ───────────
  // Durability must never depend on a timer: a phone can background or kill
  // the page at any moment. Every mutating call AWAITS its flush before
  // resolving, and flushes are serialised so two syncfs runs never overlap.
  let _pyodide = null;
  let _chain = Promise.resolve();

  function persist() {
    _chain = _chain.then(() => new Promise(resolve => {
      if (!_pyodide) return resolve();
      _pyodide.FS.syncfs(false, err => {
        if (err) console.error('[pharaon] persist failed:', err);
        resolve();
      });
    }));
    return _chain;
  }

  // Safety net for the mobile lifecycle (backgrounded / swiped away)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') persist();
  });
  window.addEventListener('pagehide', persist);

  // ── Boot ───────────────────────────────────────────────────────
  async function boot() {
    try {
      splash('Loading the engine…', 8);
      const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
      const pyodide = await loadPyodide({
        indexURL: 'pyodide/',
        env: { TZ: tz, APPDATA: DATA_DIR },
      });
      _pyodide = pyodide;

      splash('Preparing the database…', 35);
      await pyodide.loadPackage('sqlite3');

      // Persistent storage: /data lives in IndexedDB (IDBFS)
      pyodide.FS.mkdirTree(DATA_DIR);
      pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, DATA_DIR);
      await new Promise((res, rej) =>
        pyodide.FS.syncfs(true, e => e ? rej(e) : res()));   // restore previous data

      splash('Loading Pharaon’s brain…', 55);
      pyodide.FS.mkdirTree('/app/backend');
      for (const name of BACKEND_FILES) {
        const r = await fetch('backend/' + name + '.py');
        if (!r.ok) throw new Error('missing backend/' + name + '.py');
        pyodide.FS.writeFile('/app/backend/' + name + '.py', await r.text());
      }

      splash('Waking the scheduler…', 75);
      pyodide.runPython(`
import sys, os, json
os.environ['APPDATA'] = '${DATA_DIR}'
sys.path.insert(0, '/app')

# ── Platform shim (NOT logic) ──────────────────────────────────────
# backend/autostart.py drives the Windows registry "launch at login"
# feature, which cannot exist on a phone. is_autostart_enabled() only
# guards (FileNotFoundError, OSError), so the ModuleNotFoundError from
# 'import winreg' would escape here. We neutralise the two entry points
# at the boundary, leaving every backend file byte-identical to desktop.
from backend import autostart
autostart.is_autostart_enabled = lambda: False
autostart.set_autostart = lambda enabled: False

from backend.database import init_db
from backend.api import API
init_db()
_api = API()
_api.auto_backup()

def _call(name, args_json):
    fn = getattr(_api, name)
    res = fn(*json.loads(args_json))
    return json.dumps(res, default=str)
`);
      const pyCall = pyodide.globals.get('_call');

      splash('Ready.', 100);

      // ── The pywebview-compatible API surface app.js expects ────
      window.pywebview = {
        api: new Proxy({}, {
          get(_t, method) {
            return async (...args) => {
              // Platform shims that make no sense inside a browser page:
              if (method === 'open_external') {
                window.open(args[0], '_blank');
                return { success: true };
              }
              if (method === 'minimize_window' || method === 'maximize_window'
                  || method === 'close_window') {
                return { success: true };
              }
              try {
                const out = pyCall(String(method), JSON.stringify(args));
                // Mutations are durable BEFORE the UI continues; pure reads
                // (get_*) skip the flush for snappiness.
                if (!String(method).startsWith('get_')) await persist();
                return out === undefined ? {} : JSON.parse(out);
              } catch (err) {
                // Surface the real Python exception line ("KeyError: 'name'"),
                // not the trailing help URL Pyodide appends.
                const raw = String((err && err.message) || err);
                console.error('[pharaon-engine] ' + method + '\n' + raw);
                const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
                const m = lines.filter(l => /^[A-Za-z_.]*(Error|Exception)\b/.test(l)).pop()
                       || lines.filter(l => !/^See https?:/i.test(l)).pop()
                       || 'engine error';
                throw new Error(m);
              }
            };
          }
        })
      };

      hideSplash();
    } catch (err) {
      console.error('Pharaon boot failed:', err);
      splashError(String(err && err.message || err));
    }
  }

  // ── Service worker: full offline support ───────────────────────
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  boot();
})();
