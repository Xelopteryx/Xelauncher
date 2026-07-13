/**
 * calibration.js
 * Calibration écran : choix du ratio → zone safe area + taille de texte.
 * Sauvegarde dans config.json via xeLauncher.saveCalibration().
 * Applique les variables CSS à toutes les pages via common.css.
 */

'use strict';

/* ══════════════════════════════════════════════════════════════
   CONSTANTES
══════════════════════════════════════════════════════════════ */
var RATIOS = [
  { ratio: '16:9',  w: 16, h: 9  },
  { ratio: '21:9',  w: 21, h: 9  },
  { ratio: '32:9',  w: 32, h: 9  },
  { ratio: '4:3',   w: 4,  h: 3  },
  { ratio: '5:4',   w: 5,  h: 4  },
  { ratio: '16:10', w: 16, h: 10 },
];

var CORNERS = ['tl', 'tr', 'bl', 'br'];

/* Limites en px : on ne peut pas empiéter à moins de MIN_MARGIN du bord */
var MIN_MARGIN  = 0;
/* On ne peut pas réduire la safe area en dessous de MIN_SIZE (% de l'écran) */
var MIN_SIZE_PC = 0.4;

/* Pas de déplacement par touche, en px */
var STEP_PX     = 2;

/* Échelle texte : min 0.5 → max 2.0, pas 0.05 */
var TEXT_MIN    = 0.5;
var TEXT_MAX    = 2.0;
var TEXT_STEP   = 0.05;

/* ══════════════════════════════════════════════════════════════
   ÉTAT
══════════════════════════════════════════════════════════════ */
var currentStep     = 'ratio';   /* 'ratio' | 'calib' */
var ratioFocusIdx   = 0;         /* index dans RATIOS */
var selectedRatio   = null;      /* { ratio, w, h } */

var activeCornerIdx = 0;         /* index dans CORNERS */

/* safe frame en px depuis les bords de l'écran */
var frame = { top: 0, left: 0, right: 0, bottom: 0 };

var textScale = 1.0;

var inputReady = false;
var _toast     = null;
var _kb        = null;

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
  /* Détecter le ratio de l'écran et pré-sélectionner */
  var sr = detectScreenRatio();
  ratioFocusIdx = sr;
  renderRatioStep();

  /* Charger la calibration sauvegardée */
  loadSavedCalibration();

  /* Input */
  if (window.XeInput && window.XeInput.EvdevPoller) {
    var poller = new XeInput.EvdevPoller(function(key) {
      if (!inputReady) return;
      handleKey(key);
    });
    poller.start();
  }

  /* Aussi écouter le clavier natif (pour dev) */
  document.addEventListener('keydown', function(e) {
    if (!inputReady) return;
    var map = {
      ArrowLeft:  'ArrowLeft',  ArrowRight: 'ArrowRight',
      ArrowUp:    'ArrowUp',    ArrowDown:  'ArrowDown',
      Enter:      'Enter',      Escape:     'Escape',
      q: 'l1', e: 'r1',
      a: 'l2', d: 'r2',
    };
    if (map[e.key]) { e.preventDefault(); handleKey(map[e.key]); }
  });

  setTimeout(function() { inputReady = true; }, 600);
}

/* ══════════════════════════════════════════════════════════════
   DÉTECTION RATIO ÉCRAN
══════════════════════════════════════════════════════════════ */
function detectScreenRatio() {
  var w = window.screen.width  || window.innerWidth;
  var h = window.screen.height || window.innerHeight;
  var ratio = w / h;
  /* Trouver le ratio le plus proche */
  var best = 0, bestDiff = Infinity;
  RATIOS.forEach(function(r, i) {
    var diff = Math.abs(r.w / r.h - ratio);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  });
  return best;
}

/* ══════════════════════════════════════════════════════════════
   RENDU ÉTAPE 1 — RATIO
══════════════════════════════════════════════════════════════ */
function renderRatioStep() {
  var cards = document.querySelectorAll('.ratio-card');
  cards.forEach(function(card, i) {
    card.classList.remove('active', 'inactive');
    card.classList.add(i === ratioFocusIdx ? 'active' : 'inactive');
    card.addEventListener('click', function() {
      ratioFocusIdx = i;
      renderRatioStep();
    });
  });
}

/* ══════════════════════════════════════════════════════════════
   PASSAGE ÉTAPE 2 — CALIBRATION
══════════════════════════════════════════════════════════════ */
function goToCalib() {
  selectedRatio = RATIOS[ratioFocusIdx];
  currentStep   = 'calib';

  document.getElementById('stepRatio').style.display = 'none';
  document.getElementById('stepCalib').style.display = 'flex';

  /* Initialiser le frame avec des marges par défaut */
  var defaultMargin = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.05);
  frame = {
    top:    frame.top    || defaultMargin,
    left:   frame.left   || defaultMargin,
    right:  frame.right  || defaultMargin,
    bottom: frame.bottom || defaultMargin,
  };

  renderCalibStep();
  updateCornerUI();
}

/* ══════════════════════════════════════════════════════════════
   RENDU ÉTAPE 2 — CALIBRATION
══════════════════════════════════════════════════════════════ */
function renderCalibStep() {
  var W = window.innerWidth;
  var H = window.innerHeight;

  var f = document.getElementById('safeFrame');
  f.style.left   = frame.left   + 'px';
  f.style.top    = frame.top    + 'px';
  f.style.right  = frame.right  + 'px';
  f.style.bottom = frame.bottom + 'px';
  f.style.width  = (W - frame.left - frame.right)  + 'px';
  f.style.height = (H - frame.top  - frame.bottom) + 'px';

  /* Mesures */
  document.getElementById('measureTop').textContent    = frame.top    + 'px';
  document.getElementById('measureBottom').textContent = frame.bottom + 'px';
  document.getElementById('measureLeft').textContent   = frame.left   + 'px';
  document.getElementById('measureRight').textContent  = frame.right  + 'px';

  /* Échelle texte */
  var pct  = (textScale - TEXT_MIN) / (TEXT_MAX - TEXT_MIN);
  var fill = document.getElementById('textScaleFill');
  var thumb = document.getElementById('textScaleThumb');
  var val   = document.getElementById('textScaleValue');
  if (fill)  fill.style.width = (pct * 100) + '%';
  if (thumb) thumb.style.left = (pct * 100) + '%';
  if (val)   val.textContent  = Math.round(textScale * 100) + '%';

  /* Appliquer l'échelle texte dans le preview */
  document.getElementById('safeContent').style.setProperty('--calib-text-scale', textScale);
  document.documentElement.style.setProperty('--calib-text-scale', textScale);
}

/* ══════════════════════════════════════════════════════════════
   MISE À JOUR DE L'UI DES COINS
══════════════════════════════════════════════════════════════ */
function updateCornerUI() {
  CORNERS.forEach(function(c, i) {
    var el  = document.getElementById('corner' + c.toUpperCase().replace('t','T').replace('l','L').replace('r','R').replace('b','B'));
    /* recalcul : cornerTL, cornerTR, cornerBL, cornerBR */
    var elId = 'corner' + (c === 'tl' ? 'TL' : c === 'tr' ? 'TR' : c === 'bl' ? 'BL' : 'BR');
    var corner = document.getElementById(elId);
    if (corner) corner.classList.toggle('active', i === activeCornerIdx);

    var csq = document.querySelector('.csq-' + c);
    if (csq) csq.classList.toggle('active', i === activeCornerIdx);
  });
}

/* ══════════════════════════════════════════════════════════════
   DÉPLACEMENT D'UN COIN
══════════════════════════════════════════════════════════════ */
function moveActiveCorner(dx, dy) {
  var W    = window.innerWidth;
  var H    = window.innerHeight;
  var minW = W * MIN_SIZE_PC;
  var minH = H * MIN_SIZE_PC;
  var c    = CORNERS[activeCornerIdx];

  if (c === 'tl') {
    frame.left = clamp(frame.left + dx, MIN_MARGIN, W - frame.right - minW);
    frame.top  = clamp(frame.top  + dy, MIN_MARGIN, H - frame.bottom - minH);
  } else if (c === 'tr') {
    frame.right = clamp(frame.right - dx, MIN_MARGIN, W - frame.left - minW);
    frame.top   = clamp(frame.top   + dy, MIN_MARGIN, H - frame.bottom - minH);
  } else if (c === 'bl') {
    frame.left   = clamp(frame.left   + dx, MIN_MARGIN, W - frame.right - minW);
    frame.bottom = clamp(frame.bottom - dy, MIN_MARGIN, H - frame.top - minH);
  } else if (c === 'br') {
    frame.right  = clamp(frame.right  - dx, MIN_MARGIN, W - frame.left - minW);
    frame.bottom = clamp(frame.bottom - dy, MIN_MARGIN, H - frame.top - minH);
  }

  renderCalibStep();
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/* ══════════════════════════════════════════════════════════════
   NAVIGATION CLAVIER
══════════════════════════════════════════════════════════════ */
function handleKey(key) {
  if (currentStep === 'ratio') {
    if      (key === 'ArrowLeft')  { ratioFocusIdx = (ratioFocusIdx - 1 + RATIOS.length) % RATIOS.length; renderRatioStep(); }
    else if (key === 'ArrowRight') { ratioFocusIdx = (ratioFocusIdx + 1) % RATIOS.length; renderRatioStep(); }
    else if (key === 'Enter')      { goToCalib(); }
    else if (key === 'Escape')     { goBack(); }
    return;
  }

  if (currentStep === 'calib') {
    var step = STEP_PX;
    if      (key === 'ArrowLeft')  { moveActiveCorner(-step, 0); }
    else if (key === 'ArrowRight') { moveActiveCorner( step, 0); }
    else if (key === 'ArrowUp')    { moveActiveCorner(0, -step); }
    else if (key === 'ArrowDown')  { moveActiveCorner(0,  step); }
    else if (key === 'l1' || key === 'L1') {
      activeCornerIdx = (activeCornerIdx - 1 + CORNERS.length) % CORNERS.length;
      updateCornerUI();
    }
    else if (key === 'r1' || key === 'R1') {
      activeCornerIdx = (activeCornerIdx + 1) % CORNERS.length;
      updateCornerUI();
    }
    else if (key === 'l2' || key === 'L2') {
      textScale = Math.max(TEXT_MIN, parseFloat((textScale - TEXT_STEP).toFixed(2)));
      renderCalibStep();
    }
    else if (key === 'r2' || key === 'R2') {
      textScale = Math.min(TEXT_MAX, parseFloat((textScale + TEXT_STEP).toFixed(2)));
      renderCalibStep();
    }
    else if (key === 'Enter') { confirmCalibration(); }
    else if (key === 'Escape') {
      currentStep = 'ratio';
      document.getElementById('stepCalib').style.display = 'none';
      document.getElementById('stepRatio').style.display = 'flex';
    }
    return;
  }
}

/* ══════════════════════════════════════════════════════════════
   RESET
══════════════════════════════════════════════════════════════ */
function resetCalib() {
  var defaultMargin = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.05);
  frame     = { top: defaultMargin, left: defaultMargin, right: defaultMargin, bottom: defaultMargin };
  textScale = 1.0;
  renderCalibStep();
}

/* ══════════════════════════════════════════════════════════════
   SAUVEGARDE / CHARGEMENT
══════════════════════════════════════════════════════════════ */
function buildCalibData() {
  var W = window.innerWidth;
  var H = window.innerHeight;
  return {
    ratio:         selectedRatio ? selectedRatio.ratio : RATIOS[ratioFocusIdx].ratio,
    screenW:       W,
    screenH:       H,
    safeTop:       frame.top,
    safeLeft:      frame.left,
    safeRight:     frame.right,
    safeBottom:    frame.bottom,
    /* En pourcentage pour être résolution-indépendant */
    safePcTop:    +(frame.top    / H * 100).toFixed(2),
    safePcLeft:   +(frame.left   / W * 100).toFixed(2),
    safePcRight:  +(frame.right  / W * 100).toFixed(2),
    safePcBottom: +(frame.bottom / H * 100).toFixed(2),
    textScale:     textScale,
  };
}

function confirmCalibration() {
  var data = buildCalibData();

  /* Appliquer immédiatement les variables CSS globales */
  applyCSSVars(data);

  /* Persister dans config.json */
  if (window.xeLauncher && window.xeLauncher.saveCalibration) {
    window.xeLauncher.saveCalibration(data).then(function() {
      if (_toast) _toast.show('Calibration enregistrée', false);
      setTimeout(goBack, 800);
    }).catch(function() {
      if (_toast) _toast.show('Erreur sauvegarde', true);
    });
  } else {
    /* Fallback localStorage */
    try { localStorage.setItem('xelauncher_calibration', JSON.stringify(data)); } catch(e) {}
    if (_toast) _toast.show('Calibration enregistrée', false);
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
  var W = window.innerWidth;
  var H = window.innerHeight;

  /* Préférer les % (résolution-indépendant) si disponibles */
  if (data.safePcTop !== undefined) {
    frame.top    = Math.round(data.safePcTop    / 100 * H);
    frame.left   = Math.round(data.safePcLeft   / 100 * W);
    frame.right  = Math.round(data.safePcRight  / 100 * W);
    frame.bottom = Math.round(data.safePcBottom / 100 * H);
  } else {
    frame.top    = data.safeTop    || 0;
    frame.left   = data.safeLeft   || 0;
    frame.right  = data.safeRight  || 0;
    frame.bottom = data.safeBottom || 0;
  }

  textScale = data.textScale || 1.0;

  /* Pré-sélectionner le bon ratio */
  if (data.ratio) {
    var idx = RATIOS.findIndex(function(r) { return r.ratio === data.ratio; });
    if (idx >= 0) ratioFocusIdx = idx;
  }

  renderRatioStep();
}

/* ══════════════════════════════════════════════════════════════
   APPLICATION DES VARIABLES CSS
   Appelé au démarrage de chaque page via applyCalibFromStorage()
══════════════════════════════════════════════════════════════ */
function applyCSSVars(data) {
  var r    = document.documentElement;
  var W    = window.innerWidth;
  var H    = window.innerHeight;

  var top    = data.safePcTop    !== undefined ? Math.round(data.safePcTop    / 100 * H) : (data.safeTop    || 0);
  var left   = data.safePcLeft   !== undefined ? Math.round(data.safePcLeft   / 100 * W) : (data.safeLeft   || 0);
  var right  = data.safePcRight  !== undefined ? Math.round(data.safePcRight  / 100 * W) : (data.safeRight  || 0);
  var bottom = data.safePcBottom !== undefined ? Math.round(data.safePcBottom / 100 * H) : (data.safeBottom || 0);

  var scale  = data.textScale || 1.0;

  r.style.setProperty('--safe-top',    top    + 'px');
  r.style.setProperty('--safe-left',   left   + 'px');
  r.style.setProperty('--safe-right',  right  + 'px');
  r.style.setProperty('--safe-bottom', bottom + 'px');
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
   dans chaque page HTML pour appliquer la calibration au boot
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
   BOUTONS HTML
══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function() {
  var btnConfirm = document.getElementById('btnConfirm');
  var btnReset   = document.getElementById('btnReset');
  if (btnConfirm) btnConfirm.addEventListener('click', confirmCalibration);
  if (btnReset)   btnReset.addEventListener('click',   resetCalib);

  /* Sélecteurs de coins */
  document.querySelectorAll('.csq').forEach(function(el) {
    el.addEventListener('click', function() {
      var c = el.dataset.corner;
      activeCornerIdx = CORNERS.indexOf(c);
      updateCornerUI();
    });
  });

  /* Cartes ratio */
  document.querySelectorAll('.ratio-card').forEach(function(card, i) {
    card.addEventListener('click', function() {
      ratioFocusIdx = i;
      renderRatioStep();
    });
    card.addEventListener('dblclick', function() {
      ratioFocusIdx = i;
      goToCalib();
    });
  });
});

/* ══════════════════════════════════════════════════════════════
   RETOUR
══════════════════════════════════════════════════════════════ */
function goBack() {
  if (window.xeLauncher && window.xeLauncher.goBack) window.xeLauncher.goBack();
  else window.history.back();
}
