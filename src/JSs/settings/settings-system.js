/**
 * settings-system.js
 * Onglet Système : version, mise à jour, redémarrage, extinction.
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.System = (() => {

  function loadVersion() {
    if (!window.xeLauncher) return;
    window.xeLauncher.getVersion().then(v => {
      const el = document.getElementById('versionVal');
      if (el) el.textContent = v;
      const vi = document.getElementById('versionInfo');
      if (vi) vi.textContent = 'v' + v;
    });
    window.xeLauncher.checkUpdate().then(r => {
      const el = document.getElementById('updateStatus');
      if (el) el.textContent = r.available ? r.version + ' dispo' : 'À jour';
    });
  }

  function doUpdate() {
    if (!window.xeLauncher) return;
    const statusEl  = document.getElementById('updateStatus');
    const loadingEl = document.getElementById('loadingOverlay');
    const textEl    = document.getElementById('loadingText');
    if (statusEl)  statusEl.textContent  = '…';
    if (textEl)    textEl.textContent    = 'Mise à jour…';
    if (loadingEl) loadingEl.classList.add('visible');
    window.xeLauncher.systemUpdate().then(ok => {
      if (loadingEl) loadingEl.classList.remove('visible');
      toast.show(ok ? 'Mise à jour terminée' : 'Erreur', !ok);
      if (statusEl) statusEl.textContent = 'Vérification…';
      window.xeLauncher.checkUpdate().then(r => {
        if (statusEl) statusEl.textContent = r.available ? r.version + ' dispo' : 'À jour';
      });
    });
  }

  return { loadVersion, doUpdate };
})();
