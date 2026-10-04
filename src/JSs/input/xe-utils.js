/**
 * xe-utils.js
 * Constantes, utilitaires partagés, Toast, wakeLock, préférences layout.
 * Exposé sur window._XeUtils (assemblé en window.XeInput par input.js).
 *
 * v3 : actions étendues (L1/R1/L2/R2/L3/R3/Select), libellés lisibles pour
 * les raws physiques (KEY_37 -> "K", ABS_16_neg -> "← Croix"), et conversion
 * des anciens mappages (noms DOM 'k', 'ArrowUp'...) vers des raws evdev.
 */

;(function(root) {
  'use strict';

  /* ── Tables d'actions ── */
  var ACTION_TO_KEY = {
    'up':      'ArrowUp',
    'down':    'ArrowDown',
    'left':    'ArrowLeft',
    'right':   'ArrowRight',
    'confirm': 'Enter',
    'back':    'Escape',
    'menu':    'Start',
    'select':  'Select',
    'action':  'Triangle',
    'l1': 'L1', 'r1': 'R1',
    'l2': 'L2', 'r2': 'R2',
    'l3': 'L3', 'r3': 'R3',
  };

  /* Les 8 actions "historiques" (conservées pour compatibilité) */
  var ACTION_KEYS = [
    { id:'up',      label:'Haut',      default:'ArrowUp',    desc:'Naviguer vers le haut' },
    { id:'down',    label:'Bas',       default:'ArrowDown',  desc:'Naviguer vers le bas' },
    { id:'left',    label:'Gauche',    default:'ArrowLeft',  desc:'Naviguer vers la gauche' },
    { id:'right',   label:'Droite',    default:'ArrowRight', desc:'Naviguer vers la droite' },
    { id:'confirm', label:'Confirmer', default:'Enter',      desc:'Valider / lancer' },
    { id:'back',    label:'Retour',    default:'Escape',     desc:'Revenir en arrière / annuler' },
    { id:'menu',    label:'Menu',      default:'Start',      desc:'Ouvrir le menu système (Start)' },
    { id:'action',  label:'Action',    default:'Triangle',   desc:'Action secondaire (modifier un profil...)' },
  ];

  /* Plus d'actions "optionnelles" : les 8 actions sont toutes obligatoires, et
     chacune peut avoir PLUSIEURS boutons (croix, joystick, touches...). */
  var EXTRA_ACTION_KEYS = [];
  var ALL_ACTION_KEYS   = ACTION_KEYS;
  var REQUIRED_ACTIONS  = ACTION_KEYS.map(function(a) { return a.id; });

  var GP_DEFAULT = {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    confirm: 'Enter', back: 'Escape', menu: 'Start', action: 'Triangle',
  };

  /* ── Accents ET variantes de symboles ── */
  var ACCENTS = {
    'a': ['\u00e0','\u00e2','\u00e4','\u00e1','\u00e3','\u00e5','\u00e6'],
    'e': ['\u00e9','\u00e8','\u00ea','\u00eb','\u011b','\u0119'],
    'i': ['\u00ee','\u00ef','\u00ed','\u00ec','\u0129'],
    'o': ['\u00f4','\u00f6','\u00f3','\u00f2','\u00f5','\u00f8','\u0153'],
    'u': ['\u00f9','\u00fb','\u00fc','\u00fa','\u0169'],
    'c': ['\u00e7','\u0107','\u010d'],
    'n': ['\u00f1','\u0144'],
    'y': ['\u00ff','\u00fd'],
    's': ['\u0161','\u015b'],
    'z': ['\u017e','\u017a','\u017c'],
    '\'': ['\u2019','`'],
    '-':  ['_','~','^','+','='],
    '(':  ['[','{'],
    ')':  [']','}'],
    '/':  ['\\','|'],
    '@':  ['#','&'],
    '?':  ['!','\u00bf'],
    '.':  ['\u2026'],
  };

  /* ── Préférence layout clavier ── */
  function getLayoutPref() {
    try { return localStorage.getItem('xelauncher_kb_layout') || 'azerty'; } catch(e) { return 'azerty'; }
  }
  function setLayoutPref(v) {
    try { localStorage.setItem('xelauncher_kb_layout', v); } catch(e) {}
  }

  /* ── Libellés des raws physiques ── */
  var RAW_RE = /^(KEY|ABS|REL)_\d+/;

  var KEY_NAMES = {
    1:'Échap', 14:'Retour arrière', 15:'Tab', 28:'Entrée', 29:'Ctrl G', 42:'Maj G', 54:'Maj D',
    56:'Alt', 57:'Espace', 58:'Verr. Maj', 97:'Ctrl D', 100:'Alt Gr',
    102:'Début', 103:'↑', 104:'Page ↑', 105:'←', 106:'→', 107:'Fin', 108:'↓', 109:'Page ↓',
    110:'Inser', 111:'Suppr', 125:'Win G', 126:'Win D', 127:'Menu contextuel',
    87:'F11', 88:'F12',
    96:'Pavé Entrée', 98:'Pavé /', 55:'Pavé *', 74:'Pavé −', 78:'Pavé +', 83:'Pavé .',
    113:'Muet', 114:'Vol −', 115:'Vol +', 128:'Stop', 139:'Menu', 158:'Retour (télécom.)',
    163:'Suivant', 164:'Lecture/Pause', 165:'Précédent', 168:'Retour rapide', 172:'Accueil',
    207:'Lecture', 208:'Avance rapide', 352:'OK', 362:'Guide', 402:'Chaîne +', 403:'Chaîne −',
  };
  var KEY_QWERTY = {
    12:'-', 13:'=', 16:'Q', 17:'W', 18:'E', 19:'R', 20:'T', 21:'Y', 22:'U', 23:'I', 24:'O', 25:'P',
    26:'[', 27:']', 30:'A', 31:'S', 32:'D', 33:'F', 34:'G', 35:'H', 36:'J', 37:'K', 38:'L',
    39:';', 40:'\'', 41:'`', 43:'\\', 44:'Z', 45:'X', 46:'C', 47:'V', 48:'B', 49:'N', 50:'M',
    51:',', 52:'.', 53:'/',
  };
  /* Un clavier AZERTY envoie les mêmes codes physiques : seul le libellé change */
  var KEY_AZERTY_OVERRIDE = { 16:'A', 30:'Q', 17:'Z', 44:'W', 39:'M', 50:',', 51:';', 52:':', 53:'!' };
  var GP_NAMES = {
    304:'Bouton A', 305:'Bouton B', 306:'Bouton C', 307:'Bouton X', 308:'Bouton Y', 309:'Bouton Z',
    310:'L1', 311:'R1', 312:'L2', 313:'R2', 314:'Select', 315:'Start', 316:'Mode', 317:'L3', 318:'R3',
  };
  var KP = { 71:'7', 72:'8', 73:'9', 75:'4', 76:'5', 77:'6', 79:'1', 80:'2', 81:'3', 82:'0' };

  function keyLabel(code) {
    if (GP_NAMES[code]) return GP_NAMES[code];
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    if (code >= 2  && code <= 10) return String(code - 1);
    if (code === 11) return '0';
    if (code >= 59 && code <= 68) return 'F' + (code - 58);
    if (KP[code]) return 'Pavé ' + KP[code];
    if (getLayoutPref() === 'azerty' && KEY_AZERTY_OVERRIDE[code]) return KEY_AZERTY_OVERRIDE[code];
    if (KEY_QWERTY[code]) return KEY_QWERTY[code];
    if (code >= 0x2c0 && code <= 0x2ff) return 'Bouton ' + (code - 0x2c0 + 1);
    return 'Touche ' + code;
  }

  var ABS_AXIS_NAMES = { 2:'Z', 3:'RX', 4:'RY', 5:'RZ', 6:'Accélérateur', 7:'Gouvernail', 9:'Gaz', 10:'Frein' };
  function absLabel(code, dir) {
    var neg = dir === 'neg';
    if (code === 16 || code === 18) return (neg ? '←' : '→') + ' Croix';
    if (code === 17 || code === 19) return (neg ? '↑' : '↓') + ' Croix';
    if (code === 0) return (neg ? '←' : '→') + ' Stick G';
    if (code === 1) return (neg ? '↑' : '↓') + ' Stick G';
    return 'Axe ' + (ABS_AXIS_NAMES[code] || code) + (neg ? ' −' : ' +');
  }

  function prettyRaw(raw) {
    if (!raw) return '';
    var labels = {
      'up':'↑','down':'↓','left':'←','right':'→',
      'confirm':'Confirmer','back':'Retour','menu':'Menu','select':'Select',
      'action':'Action','l1':'L1','r1':'R1','l2':'L2','r2':'R2','l3':'L3','r3':'R3',
    };
    if (labels[raw]) return labels[raw];
    var m = /^KEY_(\d+)$/.exec(raw);
    if (m) return keyLabel(parseInt(m[1], 10));
    m = /^ABS_(\d+)_(neg|pos)$/.exec(raw);
    if (m) return absLabel(parseInt(m[1], 10), m[2]);
    m = /^REL_(\d+)_(neg|pos)$/.exec(raw);
    if (m) return 'Souris ' + (m[2] === 'neg' ? '−' : '+') + ' (axe ' + m[1] + ')';
    return raw;
  }

  /* ── Anciens mappages (noms DOM) -> raw evdev ── */
  var DOM_CODES = {
    ArrowUp:103, ArrowDown:108, ArrowLeft:105, ArrowRight:106, Enter:28, Escape:1,
    Backspace:14, Tab:15, ' ':57, Shift:42, Control:29, Alt:56, Delete:111, Home:102,
    End:107, PageUp:104, PageDown:109, Insert:110, CapsLock:58, Meta:125, ContextMenu:127,
  };
  function legacyToRaw(val) {
    if (val == null || val === '') return null;
    val = String(val);
    if (RAW_RE.test(val)) return val;
    if (DOM_CODES.hasOwnProperty(val)) return 'KEY_' + DOM_CODES[val];
    var f = /^F([1-9]|1[0-2])$/.exec(val);
    if (f) { var n = parseInt(f[1], 10); return 'KEY_' + (n <= 10 ? 58 + n : (n === 11 ? 87 : 88)); }
    if (val.length === 1) {
      var low = val.toLowerCase();
      for (var c = 1; c <= 127; c++) {
        var l = keyLabel(c);
        if (l.length === 1 && l.toLowerCase() === low) return 'KEY_' + c;
      }
    }
    return null;
  }

  /* ── Wake lock ── */
  var _wakeLock = null;
  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        _wakeLock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', async function() {
          if (document.visibilityState === 'visible' && _wakeLock === null)
            _wakeLock = await navigator.wakeLock.request('screen');
        });
      } catch(e) {}
    }
  }

  /* ── Toast ── */
  function Toast(el) { this.el = el; this._t = null; }
  Toast.prototype.show = function(msg, isError, duration) {
    if (!this.el) return;
    this.el.textContent = msg;
    this.el.className   = 'toast show' + (isError ? ' error' : '');
    if (this._t) clearTimeout(this._t);
    var el = this.el;
    if (!isError) this._t = setTimeout(function() { el.classList.remove('show'); }, duration || 2500);
  };
  Toast.prototype.hide = function() {
    if (this.el) this.el.classList.remove('show');
    if (this._t) clearTimeout(this._t);
  };

  root._XeUtils = {
    ACTION_TO_KEY, ACTION_KEYS, EXTRA_ACTION_KEYS, ALL_ACTION_KEYS, REQUIRED_ACTIONS,
    GP_DEFAULT, ACCENTS, RAW_RE,
    prettyRaw, keyLabel, legacyToRaw, getLayoutPref, setLayoutPref, requestWakeLock, Toast,
  };

})(typeof window !== 'undefined' ? window : this);
