/**
 * settings-system.js
 * Onglet Système : version (bandeau bas-droite), mise à jour avec
 * progression réelle, redémarrage, extinction, bloc "À propos" (specs).
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.System = (() => {

  function loadVersion() {
    if (!window.xeLauncher) return;
    window.xeLauncher.getVersion().then(v => {
      const vi = document.getElementById('versionInfo');
      if (vi) vi.textContent = 'v' + v;
    });
    window.xeLauncher.checkUpdate().then(r => {
      const el = document.getElementById('updateStatus');
      if (el) el.textContent = r.available ? r.version + ' dispo' : 'À jour';
    });
  }

  /* ── Bloc "À propos" — specs machine ── */
  function loadSpecs() {
    if (!window.xeLauncher?.getSystemSpecs) return;
    window.xeLauncher.getSystemSpecs().then(specs => {
      if (!specs) return;
      const cpuEl  = document.getElementById('specCpu');
      const ramEl  = document.getElementById('specRam');
      const diskEl = document.getElementById('specDisk');
      const osEl   = document.getElementById('specOs');
      if (cpuEl)  cpuEl.textContent  = specs.cpuModel + ' (' + specs.cpuCores + ' cœurs)';
      if (ramEl)  ramEl.textContent  = specs.ramTotal;
      if (diskEl) diskEl.textContent = specs.diskText;
      if (osEl)   osEl.textContent   = specs.osText;
    }).catch(() => {});
  }

  /* ── Mise à jour — barre de progression au lieu du spinner ── */
  function doUpdate() {
    if (!window.xeLauncher) return;
    const statusEl = document.getElementById('updateStatus');
    const wrap     = document.getElementById('updateProgressWrap');
    const bar      = document.getElementById('updateProgressBar');
    const label    = document.getElementById('updateProgressLabel');

    if (statusEl) statusEl.textContent = '…';
    if (bar)      bar.style.width      = '0%';
    if (label)    label.textContent    = '0%';
    if (wrap)     wrap.style.display   = 'flex';

    if (window.xeLauncher.onSystemUpdateProgress) {
      window.xeLauncher.onSystemUpdateProgress((data) => {
        const pct = Math.max(0, Math.min(100, Math.round(data.percent || 0)));
        if (bar)   bar.style.width = pct + '%';
        if (label) {
          label.textContent = pct + '%' + (data.total ? ' · ' + data.total + ' paquet' + (data.total > 1 ? 's' : '') : '');
        }
      });
    }

    window.xeLauncher.systemUpdate().then(ok => {
      if (window.xeLauncher.offSystemUpdateProgress) window.xeLauncher.offSystemUpdateProgress();
      if (bar)   bar.style.width   = '100%';
      if (label) label.textContent = '100%';
      setTimeout(() => { if (wrap) wrap.style.display = 'none'; }, 500);

      toast.show(ok ? 'Mise à jour terminée' : 'Erreur', !ok);
      if (statusEl) statusEl.textContent = 'Vérification…';
      window.xeLauncher.checkUpdate().then(r => {
        if (statusEl) statusEl.textContent = r.available ? r.version + ' dispo' : 'À jour';
      });
    }).catch(() => {
      if (window.xeLauncher.offSystemUpdateProgress) window.xeLauncher.offSystemUpdateProgress();
      if (wrap) wrap.style.display = 'none';
      toast.show('Erreur', true);
    });
  }

  return { loadVersion, loadSpecs, doUpdate };
})();
