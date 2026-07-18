/* ═══════════════════════════════════════════════════════════════
   PHARAON MOBILE — interaction layer
   Small, additive glue on top of the untouched app.js:
   the "More" bottom sheet, stat mirroring, and sheet lifecycle.
   Navigation itself needs nothing here: bottom-nav and sheet links
   carry the same .nav-item / data-page contract app.js already wires.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

(function () {
  const sheet    = document.getElementById('moreSheet');
  const backdrop = document.getElementById('sheetBackdrop');
  const moreBtn  = document.getElementById('bnMore');

  function openSheet() {
    sheet.hidden = false; backdrop.hidden = false;
    requestAnimationFrame(() => {
      sheet.classList.add('show'); backdrop.classList.add('show');
    });
    syncSheetStats();
  }
  function closeSheet() {
    sheet.classList.remove('show'); backdrop.classList.remove('show');
    setTimeout(() => { sheet.hidden = true; backdrop.hidden = true; }, 220);
  }

  moreBtn.addEventListener('click', () =>
    sheet.hidden ? openSheet() : closeSheet());
  backdrop.addEventListener('click', closeSheet);

  // Page links inside the sheet: app.js handles navigation; we just close.
  sheet.querySelectorAll('.nav-item[data-page]').forEach(el =>
    el.addEventListener('click', closeSheet));

  // Settings from the sheet
  document.getElementById('sheetSettings').addEventListener('click', () => {
    closeSheet();
    setTimeout(() => openSettingsModal(), 180);
  });

  // Mirror the sidebar stats into the sheet (source of truth: app.js)
  function syncSheetStats() {
    const st = document.getElementById('sfStreak');
    const dn = document.getElementById('sfDone');
    const ms = document.getElementById('msStreak');
    const md = document.getElementById('msDone');
    if (st && ms) ms.textContent = st.textContent;
    if (dn && md) md.textContent = dn.textContent;
  }
  new MutationObserver(syncSheetStats).observe(
    document.getElementById('sfStreak'), { childList: true, characterData: true, subtree: true });
  new MutationObserver(syncSheetStats).observe(
    document.getElementById('sfDone'), { childList: true, characterData: true, subtree: true });

  // "More" tab lights up when one of its pages is active
  const morePages = ['recall', 'fitness', 'otherdates'];
  const origNavigate = window.navigate;
  window.navigate = function (page) {
    origNavigate(page);
    moreBtn.classList.toggle('active', morePages.includes(page));
  };

  // "Launch at login" is a Windows-only feature — hide that section on mobile.
  // The checkbox stays in the DOM so saveSettings() keeps working untouched.
  const origSettings = window.openSettingsModal;
  window.openSettingsModal = function () {
    origSettings();
    document.querySelectorAll('#modal .settings-section').forEach(sec => {
      const t = sec.querySelector('.settings-section-title');
      if (t && t.textContent.trim() === 'Startup') sec.style.display = 'none';
    });
  };
})();
