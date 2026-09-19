/**
 * calibration.js
 * Réglage de la taille du texte à l'affichage.
 * Sauvegarde dans config.json via xeLauncher.saveCalibration().
 * Applique la variable CSS --calib-text-scale (et recalcule les --fs-*)
 * à toutes les pages via common.css.
 *
 * NB: l'ancien système de cadrage (safe-area par coins draggables + choix
 * de ratio écran) a été retiré — les variables --safe-* qu'il calculait
 * n'étaient consommées par aucune autre page, donc ça ne servait à rien
 * en dehors de cet écran. Seule la taille de texte est conservée, car
 * elle, elle est bien utilisée partout via les clamp() de common.css.
 */

'use strict';

/* Échelle texte : min 0.5 → max 2.0, pas 0.05 */
var TEXT_MIN  = 0.5;
var TEXT_MAX  = 2.0;
var TEXT_STEP = 0.05;

var textScale  = 1.0;
var inputReady = false;
var _toast     = null;

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
  _toast = new (function() {
    var el = document.getElementById('toast');
    this.show = function(msg, isError) {
      el.textContent = msg;
      el.className = 'toast show' + (isError ? ' error' : '');
      clearTimeout(this._t);
      this._t = setTimeout(function() { el.classList.remove('show'); }, 2500);
    };
  })();

  waitForXeInput(initCalibration);
});

function waitForXeInput(cb, attempts) {
  attempts = attempts || 0;
  if (window.XeInput && window.XeInput.EvdevPoller) { cb(); return; }
  if (attempts < 50) { setTimeout(function() { waitForXeInput(cb, attempts + 1); }, 20); }
  else { cb(); } /* continuer même sans input */
}

function initCalibration() {
  renderTextScale();
  loadSavedCalibration();

  /* Manette / télécommande */
  if (window.XeInput && window.XeInput.EvdevPoller) {
    var poller = new XeInput.EvdevPoller(function(key) {
      if (!inputReady) return;
      handleKey(key);
    });
    poller.start();
  }

  /* Clavier natif (pour dev) */
  document.addEventListener('keydown', function(e) {
    if (!inputReady) return;
    var map = {
      ArrowLeft:  'ArrowLeft',  ArrowRight: 'ArrowRight',
      Enter:      'Enter',      Escape:     'Escape',
    };
    if (map[e.key]) { e.preventDefault(); handleKey(map[e.key]); }
  });

  var btnConfirm = document.getElementById('btnConfirm');
  var btnReset   = document.getElementById('btnReset');
  if (btnConfirm) btnConfirm.addEventListener('click', confirmCalibration);
  if (btnReset)   btnReset.addEventListener('click',   resetCalib);

  setTimeout(function() { inputReady = true; }, 600);
}

/* ══════════════════════════════════════════════════════════════
   RENDU
══════════════════════════════════════════════════════════════ */
function renderTextScale() {
  var pct   = (textScale - TEXT_MIN) / (TEXT_MAX - TEXT_MIN);
  var fill  = document.getElementById('textScaleFill');
  var thumb = document.getElementById('textScaleThumb');
  var val   = document.getElementById('textScaleValue');
  if (fill)  fill.style.width = (pct * 100) + '%';
  if (thumb) thumb.style.left = (pct * 100) + '%';
  if (val)   val.textContent  = Math.round(textScale * 100) + '%';

  var preview = document.getElementById('calibPreview');
  if (preview) preview.style.setProperty('--calib-text-scale', textScale);
  document.documentElement.style.setProperty('--calib-text-scale', textScale);
}

/* ══════════════════════════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════════════════════════ */
function handleKey(key) {
  if      (key === 'ArrowLeft')  { textScale = Math.max(TEXT_MIN, parseFloat((textScale - TEXT_STEP).toFixed(2))); renderTextScale(); }
  else if (key === 'ArrowRight') { textScale = Math.min(TEXT_MAX, parseFloat((textScale + TEXT_STEP).toFixed(2))); renderTextScale(); }
  else if (key === 'Enter')      { confirmCalibration(); }
  else if (key === 'Escape')     { goBack(); }
}

/* ══════════════════════════════════════════════════════════════
   RESET
══════════════════════════════════════════════════════════════ */
function resetCalib() {
  textScale = 1.0;
  renderTextScale();
}

/* ══════════════════════════════════════════════════════════════
   SAUVEGARDE / CHARGEMENT
══════════════════════════════════════════════════════════════ */
function buildCalibData() {
  return { textScale: textScale };
}

function confirmCalibration() {
  var data = buildCalibData();

  /* Appliquer immédiatement la variable CSS globale */
  applyCSSVars(data);

  /* Persister dans config.json */
  if (window.xeLauncher && window.xeLauncher.saveCalibration) {
    window.xeLauncher.saveCalibration(data).then(function() {
      if (_toast) _toast.show('Taille du texte enregistrée', false);
      setTimeout(goBack, 800);
    }).catch(function() {
      if (_toast) _toast.show('Erreur sauvegarde', true);
    });
  } else {
    /* Fallback localStorage */
    try { localStorage.setItem('xelauncher_calibration', JSON.stringify(data)); } catch(e) {}
    if (_toast) _toast.show('Taille du texte enregistrée', false);
    setTimeout(goBack, 800);
  }
}

function loadSavedCalibration() {
  var fallback = null;
  try { fallback = JSON.parse(localStorage.getItem('xelauncher_calibration') || 'null'); } catch(e) {}

  if (window.xeLauncher && window.xeLauncher.getConfig) {
    window.xeLauncher.getConfig().then(function(cfg) {
      var data = (cfg && cfg.calibration) ? cfg.calibration : fallback;
      if (data) applyLoadedCalib(data);
    }).catch(function() {
      if (fallback) applyLoadedCalib(fallback);
    });
  } else if (fallback) {
    applyLoadedCalib(fallback);
  }
}

function applyLoadedCalib(data) {
  textScale = data.textScale || 1.0;
  renderTextScale();
}

/* ══════════════════════════════════════════════════════════════
   APPLICATION DE LA VARIABLE CSS
   Appelé au démarrage de chaque page via applyCalibFromStorage()
══════════════════════════════════════════════════════════════ */
function applyCSSVars(data) {
  var r     = document.documentElement;
  var scale = data.textScale || 1.0;

  r.style.setProperty('--calib-text-scale', scale);

  /* Recalculer les tailles de police en tenant compte du scale */
  var bases = {
    '--fs-hint':  [9,  1.3, 20],
    '--fs-small': [11, 1.6, 24],
    '--fs-body':  [13, 2.0, 30],
    '--fs-label': [10, 1.5, 22],
    '--fs-title': [16, 2.8, 42],
    '--fs-hero':  [24, 5.0, 72],
    '--fs-key':   [12, 1.7, 24],
  };

  Object.keys(bases).forEach(function(varName) {
    var b = bases[varName];
    var min = Math.round(b[0] * scale);
    var vw  = +(b[1] * scale).toFixed(2);
    var max = Math.round(b[2] * scale);
    r.style.setProperty(varName, 'clamp(' + min + 'px, ' + vw + 'vw, ' + max + 'px)');
  });
}

/* ══════════════════════════════════════════════════════════════
   FONCTION GLOBALE — appelée par common.css via inline script
   dans chaque page HTML pour appliquer le scale au boot
══════════════════════════════════════════════════════════════ */
window.applyCalibFromStorage = function() {
  var data = null;
  try { data = JSON.parse(localStorage.getItem('xelauncher_calibration') || 'null'); } catch(e) {}
  if (!data && window.xeLauncher && window.xeLauncher.getConfig) {
    window.xeLauncher.getConfig().then(function(cfg) {
      if (cfg && cfg.calibration) applyCSSVars(cfg.calibration);
    });
    return;
  }
  if (data) applyCSSVars(data);
};

/* ══════════════════════════════════════════════════════════════
   RETOUR
══════════════════════════════════════════════════════════════ */
function goBack() {
  if (window.xeLauncher && window.xeLauncher.goBack) window.xeLauncher.goBack();
  else window.history.back();
}
