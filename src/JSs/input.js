/**
 * XeLauncher - Unified Input Manager
 * Layouts: QWERTY / AZERTY (switch via settings)
 * Types de clavier: 'normal' (noms/mdp) | 'url' (adresses serveur)
 */

;(function(root) {
  'use strict';

  /* ================================================================
   * VARIANTES ACCENTUEES
   * ================================================================ */
  const ACCENTS = {
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
  };

  /* ================================================================
   * LAYOUTS
   * ================================================================ */

  // QWERTY
  const QWERTY = {
    letters: [
      ['q','w','e','r','t','y','u','i','o','p'],
      ['a','s','d','f','g','h','j','k','l',null],
      [null,'z','x','c','v','b','n','m',null,null],
    ],
    nums: [
      ['7','8','9',null,null,null,null,null,null,null],
      ['4','5','6',null,null,null,null,null,null,null],
      ['1','2','3',null,null,null,null,null,null,null],
      ['0','.',':',null,null,null,null,null,null,null],
    ],
    specials: [
      ['!','?','.',',',';',':','\'','"','(',')'],
      ['-','_','&','~','#','{','[','|','`','\\'],
      [null,'^','@',']','}','=','/','+',' ',null],
    ],
  };

  // AZERTY
  const AZERTY = {
    letters: [
      ['a','z','e','r','t','y','u','i','o','p'],
      ['q','s','d','f','g','h','j','k','l','m'],
      [null,'w','x','c','v','b','n',null,null,null],
    ],
    nums: [
      ['7','8','9',null,null,null,null,null,null,null],
      ['4','5','6',null,null,null,null,null,null,null],
      ['1','2','3',null,null,null,null,null,null,null],
      ['0','.',':',null,null,null,null,null,null,null],
    ],
    specials: [
      ['!','?','.',',',';',':','\'','"','(',')'],
      ['-','_','&','~','#','{','[','|','`','\\'],
      [null,'^','@',']','}','=','/','+',' ',null],
    ],
  };

  // Partie numerique et specials URL (commune aux deux layouts)
  const URL_NUMS = [
    ['7','8','9',null,null,null,null,null,null,null],
    ['4','5','6',null,null,null,null,null,null,null],
    ['1','2','3',null,null,null,null,null,null,null],
    ['0','.',':',null,null,null,null,null,null,null],
  ];
  const URL_SPECIALS = [
    ['-','_','~','.','/','?','#','[',']','@'],
    ['!','$','&','\'','(',')','*','+',',',';'],
    [null,'=','%',null,null,null,null,null,null,null],
  ];

  // Barres du bas
  const BOTTOM_NORMAL = [
    { label:'MAJ',    col:0, span:2, action:'shift' },
    { label:'ESPACE', col:2, span:4, action:'space' },
    { label:'\u232b', col:6, span:2, action:'back'  },
    { label:'OK',     col:8, span:2, action:'ok'    },
  ];
  const BOTTOM_URL = [
    { label:'\u232b', col:0, span:4, action:'back' },
    { label:'OK',     col:6, span:4, action:'ok'   },
  ];

  const MODES_NORMAL  = ['letters','nums','specials'];
  const LABELS_NORMAL = ['A-Z','0-9','!@#'];
  const MODES_URL     = ['letters','nums','specials'];
  const LABELS_URL    = ['a-z','0-9',':/'];

  const KB_COLS = 10;

  /* -- Preference layout ----------------------------------------- */
  function getLayoutPref() {
    try { return localStorage.getItem('xelauncher_kb_layout') || 'azerty'; }
    catch(e) { return 'azerty'; }
  }
  function setLayoutPref(v) {
    try { localStorage.setItem('xelauncher_kb_layout', v); } catch(e) {}
  }

  /* ================================================================
   * VirtualKeyboard
   * ================================================================ */
  function VirtualKeyboard(containerEl, displayEl, modesEl, type) {
    this.container = containerEl;
    this.display   = displayEl;
    this.modes     = modesEl;
    this.type      = (type === 'url') ? 'url' : 'normal';

    this.mode    = 'letters';
    this.caps    = false;
    this._capsLastPress = 0;
    this.section  = 'kb';
    this.topFocus = 0;
    this.row = 0;
    this.col = 0;
    this.value = '';
    this.onConfirm = null;
    this.onCancel  = null;

    this._accentKey       = null;
    this._accentIndex     = -1;
    this._accentTargetBtn = null;
    this._renderScheduled = false;
    this._render();
  }

  /* -- Helpers --------------------------------------------------- */
  VirtualKeyboard.prototype._getLayouts = function() {
    var base = getLayoutPref() === 'qwerty' ? QWERTY : AZERTY;
    if (this.type === 'url') {
      return { letters: base.letters, nums: URL_NUMS, specials: URL_SPECIALS };
    }
    return base;
  };
  VirtualKeyboard.prototype._getModeNames  = function() { return this.type === 'url' ? MODES_URL    : MODES_NORMAL;  };
  VirtualKeyboard.prototype._getModeLabels = function() { return this.type === 'url' ? LABELS_URL   : LABELS_NORMAL; };
  VirtualKeyboard.prototype._getBottom     = function() { return this.type === 'url' ? BOTTOM_URL   : BOTTOM_NORMAL; };

  VirtualKeyboard.prototype._rows = function() {
    var layouts = this._getLayouts();
    var raw = layouts[this.mode];
    return raw ? raw.filter(function(r) { return r !== null; }) : [];
  };

  VirtualKeyboard.prototype._nearestCol = function(ri, col) {
    var rows   = this._rows();
    var bottom = this._getBottom();
    if (ri === rows.length) {
      var best = bottom[0].col, bestD = 999;
      bottom.forEach(function(b) {
        var mid = b.col + Math.floor(b.span / 2);
        var d   = Math.abs(mid - col);
        if (d < bestD) { bestD = d; best = b.col; }
      });
      return best;
    }
    var row = rows[ri];
    if (row[col] !== null) return col;
    var bestC = col, bestDC = 999;
    for (var c = 0; c < KB_COLS; c++) {
      if (row[c] !== null) {
        var dc = Math.abs(c - col);
        if (dc < bestDC) { bestDC = dc; bestC = c; }
      }
    }
    return bestC;
  };

  /* -- Rendu ----------------------------------------------------- */
  VirtualKeyboard.prototype._doRender = function() {
    if (!this.container) return;
    var self       = this;
    var rows       = this._rows();
    var bottom     = this._getBottom();
    var modeNames  = this._getModeNames();
    var modeLabels = this._getModeLabels();
    this.container.innerHTML = '';
    this._accentTargetBtn = null;

    rows.forEach(function(row, ri) {
      var rowEl = document.createElement('div');
      rowEl.className = 'kb-row';
      row.forEach(function(key, ci) {
        var btn      = document.createElement('div');
        var isActive  = self.section === 'kb' && self.row === ri && self.col === ci;
        var hasAccent = self.type === 'normal' && self.mode === 'letters' && key && ACCENTS[key];
        var displayKey = key;
        if (key && self.type === 'normal' && self.mode === 'letters') {
          displayKey = (self.caps === true || self.caps === 'once') ? key.toUpperCase() : key;
        }
        btn.className = 'kb-key'
          + (key === null  ? ' invisible'  : '')
          + (isActive      ? ' kbactive'   : '')
          + (hasAccent     ? ' has-accent' : '');
        if (key !== null) btn.textContent = displayKey;

        if (isActive && self.section === 'accent' && self._accentKey === key) {
          self._accentTargetBtn = btn;
        }
        if (key !== null) {
          btn.addEventListener('click', function() {
            self.section = 'kb'; self.row = ri; self.col = ci;
            self._pressKey();
          });
        }
        rowEl.appendChild(btn);
      });
      self.container.appendChild(rowEl);
    });

    // Barre du bas
    var bottomEl = document.createElement('div');
    bottomEl.className = 'kb-row';
    var bri = rows.length;
    bottom.forEach(function(b, bi) {
      var btn = document.createElement('div');
      var isActive = self.section === 'kb' && self.row === bri && self.col === b.col;
      btn.className = 'kb-key'
        + (b.action === 'ok'    ? ' confirm'   : '')
        + (b.action === 'shift' && (self.caps === 'once' || self.caps === true) ? ' shift-on'  : '')
        + (b.action === 'shift' && self.caps === true ? ' caps-lock' : '')
        + (isActive ? ' kbactive' : '');
      btn.style.gridColumn = (b.col + 1) + '/span ' + b.span;
      btn.textContent = b.label;
      btn.addEventListener('click', function() {
        self.section = 'kb'; self.row = bri; self.col = b.col;
        self._pressBottom(bi);
      });
      bottomEl.appendChild(btn);
    });
    this.container.appendChild(bottomEl);

    // Boutons de mode
    if (this.modes) {
      var activeIdx = modeNames.indexOf(this.mode);
      this.modes.querySelectorAll('.kb-mode-btn').forEach(function(btn, i) {
        btn.className = 'kb-mode-btn'
          + (i === activeIdx ? ' on' : '')
          + (self.section === 'top' && self.topFocus === i ? ' kbactive' : '');
        btn.textContent = modeLabels[i];
      });
    }

    if (this.display) this.display.textContent = this.value + '|';
    this._renderAccentMenu();
  };

  VirtualKeyboard.prototype._render = function() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    var self = this;
    requestAnimationFrame(function() { self._renderScheduled = false; self._doRender(); });
  };

  /* -- Menu accent popup fixe ------------------------------------ */
  VirtualKeyboard.prototype._renderAccentMenu = function() {
    var existing = document.getElementById('kb-accent-popup');
    if (existing) existing.parentNode.removeChild(existing);
    if (this.section !== 'accent' || !this._accentKey) return;

    var self     = this;
    var variants = ACCENTS[this._accentKey] || [];
    if (!variants.length) return;

    var menu = document.createElement('div');
    menu.id        = 'kb-accent-popup';
    menu.className = 'kb-accent-menu';
    menu.style.position = 'fixed';
    menu.style.zIndex   = '99999';

    variants.forEach(function(v, vi) {
      var item = document.createElement('div');
      item.className = 'kb-accent-item'
        + (self._accentIndex >= 0 && vi === self._accentIndex ? ' kbactive' : '');
      item.textContent = v;
      item.addEventListener('click', function() {
        self.value = self.value.slice(0, -1) + v;
        if (self.caps === 'once') self.caps = false;
        self._closeAccent();
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);

    requestAnimationFrame(function() {
      var btn = self._accentTargetBtn;
      if (!btn || !btn.isConnected) return;
      var rect  = btn.getBoundingClientRect();
      var menuW = menu.offsetWidth;
      var menuH = menu.offsetHeight;
      var left  = rect.left + rect.width / 2 - menuW / 2;
      var top   = rect.top - menuH - 10;
      left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
      if (top < 8) top = rect.bottom + 10;
      menu.style.left = left + 'px';
      menu.style.top  = top  + 'px';
    });
  };

  VirtualKeyboard.prototype._closeAccent = function() {
    this.section          = 'kb';
    this._accentKey       = null;
    this._accentTargetBtn = null;
    var existing = document.getElementById('kb-accent-popup');
    if (existing) existing.parentNode.removeChild(existing);
    this._render();
  };

  /* -- Actions --------------------------------------------------- */
  VirtualKeyboard.prototype._insertChar = function(ch) {
    this.value += ch;
    if (this.caps === 'once') this.caps = false;
  };

  VirtualKeyboard.prototype._pressKey = function() {
    var rows = this._rows();
    if (this.row === rows.length) {
      var bi = 0, col = this.col;
      this._getBottom().forEach(function(b, i) { if (col >= b.col && col < b.col + b.span) bi = i; });
      this._pressBottom(bi);
      return;
    }
    var key = rows[this.row][this.col];
    if (!key) return;

    var ch = key;
    if (this.type === 'normal' && this.mode === 'letters') {
      ch = (this.caps === true || this.caps === 'once') ? key.toUpperCase() : key;
    }

    if (this.type === 'normal' && this.mode === 'letters' && ACCENTS[key]) {
      if (this.section === 'accent' && this._accentKey === key) {
        this._closeAccent(); return;
      }
      if (this.section === 'accent') this.value = this.value.slice(0, -1);
      this._insertChar(ch);
      this.section = 'accent'; this._accentKey = key; this._accentIndex = -1;
      this._render();
      return;
    }

    if (this.section === 'accent') this._closeAccent();
    this._insertChar(ch);
    this._render();
  };

  VirtualKeyboard.prototype._pressBottom = function(bi) {
    var b = this._getBottom()[bi];
    if (!b) return;
    switch (b.action) {
      case 'shift':
        if (this.type === 'normal') {
          var now = Date.now();
          if (now - this._capsLastPress < 1000 && this.caps === 'once') { this.caps = true; }
          else if (this.caps === true) { this.caps = false; }
          else { this.caps = 'once'; }
          this._capsLastPress = now;
        }
        break;
      case 'space': this.value += ' '; break;
      case 'back':  this.value = this.value.slice(0, -1); break;
      case 'ok':
        if (this.onConfirm) this.onConfirm(this.value);
        return;
    }
    this._render();
  };

  VirtualKeyboard.prototype.setMode = function(m) {
    this.mode = m; this.section = 'kb'; this._accentKey = null;
    this.row = 0; this.col = this._nearestCol(0, 0);
    this._render();
  };

  VirtualKeyboard.prototype.open = function(initialValue, label) {
    this.value = initialValue || ''; this.caps = false;
    this.mode = 'letters'; this.section = 'kb'; this._accentKey = null;
    this.row = 0; this.col = 0; this.topFocus = 0;
    if (label && this.display) {
      var lbl = this.display.previousElementSibling;
      if (lbl && lbl.classList.contains('kb-label')) lbl.textContent = label;
    }
    this._render();
  };

  /* -- Navigation clavier physique / manette --------------------- */
  VirtualKeyboard.prototype.handleKey = function(key) {
    var rows      = this._rows();
    var maxRow    = rows.length;
    var modeNames = this._getModeNames();
    var bottom    = this._getBottom();
    var handled   = true;

    if (this.section === 'accent') {
      var variants = ACCENTS[this._accentKey] || [];
      if      (key === 'ArrowLeft')  { this._accentIndex = this._accentIndex < 0 ? variants.length - 1 : (this._accentIndex - 1 + variants.length) % variants.length; }
      else if (key === 'ArrowRight') { this._accentIndex = (this._accentIndex + 1) % variants.length; }
      else if (key === 'Enter') {
        if (this._accentIndex >= 0) this.value = this.value.slice(0, -1) + variants[this._accentIndex];
        this._closeAccent(); return true;
      }
      else if (key === 'Escape' || key === 'ArrowUp' || key === 'ArrowDown') { this._closeAccent(); }
      else { handled = false; }
      if (handled) this._render();
      return handled;
    }

    if (key === 'ArrowUp') {
      if (this.section === 'kb' && this.row === 0) { this.section = 'top'; }
      else if (this.section === 'kb') { this.row--; this.col = this._nearestCol(this.row, this.col); }
    } else if (key === 'ArrowDown') {
      if (this.section === 'top') { this.section = 'kb'; this.row = 0; this.col = this._nearestCol(0, this.col); }
      else if (this.row < maxRow)  { this.row++; this.col = this._nearestCol(this.row, this.col); }
    } else if (key === 'ArrowLeft') {
      if (this.section === 'top') {
        this.topFocus = (this.topFocus - 1 + modeNames.length) % modeNames.length;
      } else if (this.row === maxRow) {
        var biL = 0, colL = this.col;
        bottom.forEach(function(b, i) { if (colL >= b.col && colL < b.col + b.span) biL = i; });
        this.col = bottom[(biL - 1 + bottom.length) % bottom.length].col;
      } else {
        var ncL = (this.col - 1 + KB_COLS) % KB_COLS, trL = 0;
        while (rows[this.row][ncL] === null && trL < KB_COLS) { ncL = (ncL - 1 + KB_COLS) % KB_COLS; trL++; }
        this.col = ncL;
      }
    } else if (key === 'ArrowRight') {
      if (this.section === 'top') {
        this.topFocus = (this.topFocus + 1) % modeNames.length;
      } else if (this.row === maxRow) {
        var biR = 0, colR = this.col;
        bottom.forEach(function(b, i) { if (colR >= b.col && colR < b.col + b.span) biR = i; });
        this.col = bottom[(biR + 1) % bottom.length].col;
      } else {
        var ncR = (this.col + 1) % KB_COLS, trR = 0;
        while (rows[this.row][ncR] === null && trR < KB_COLS) { ncR = (ncR + 1) % KB_COLS; trR++; }
        this.col = ncR;
      }
    } else if (key === 'Enter') {
      if (this.section === 'top') this.setMode(modeNames[this.topFocus]);
      else this._pressKey();
    } else if (key === 'Escape') {
      if (this.onCancel) this.onCancel();
    } else { handled = false; }

    if (handled) this._render();
    return handled;
  };

  /* ================================================================
   * EvdevPoller — reçoit les events de xe_input.py via IPC
   * Format reçu : { device: string, action: string }
   * action = 'up'|'down'|'left'|'right'|'confirm'|'back'|'menu'|'select'|
   *          'action'|'l1'|'r1'|'l2'|'r2'|'l3'|'r3'
   * ================================================================ */

  // Map action -> clé logique XeLauncher
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
    'l1':      'L1',
    'r1':      'R1',
    'l2':      'L2',
    'r2':      'R2',
    'l3':      'L3',
    'r3':      'R3',
  };

  // Formate un raw key (action) pour affichage
  function prettyRaw(raw) {
    if (!raw) return '';
    var labels = {
      'up':'↑','down':'↓','left':'←','right':'→',
      'confirm':'Confirmer','back':'Retour','menu':'Menu','select':'Select',
      'action':'Action','l1':'L1','r1':'R1','l2':'L2','r2':'R2','l3':'L3','r3':'R3',
    };
    return labels[raw] || raw;
  }

  function EvdevPoller(onKey) {
    this.onKey       = onKey;
    this._customMaps = null;   // ref vers InputMapper._maps
    this.onRawEvent  = null;   // (action, deviceName) avant résolution — pour le mapper
    this.debugMode   = false;
    this.onDebug     = null;   // ({raw, device}) en mode debug
    this._bound      = null;
    this._running    = false;
  }

  EvdevPoller.prototype.start = function() {
    if (this._running) return;
    if (!window.xeLauncher || !window.xeLauncher.onXeInputEvent) {
      console.warn('EvdevPoller: onXeInputEvent non disponible');
      return;
    }
    // Retirer tout listener IPC précédent AVANT d'en ajouter un nouveau.
    // ipcRenderer.on() accumule les listeners — sans ce nettoyage, chaque
    // navigation back/forward dans Electron empile un listener supplémentaire
    // et chaque event physique est déclenché N fois.
    if (window.xeLauncher.offXeInputEvent) window.xeLauncher.offXeInputEvent();
    this._running = true;
    var self = this;
    this._bound = function(data) { self._onEvent(data); };
    window.xeLauncher.onXeInputEvent(this._bound);
  };

  EvdevPoller.prototype.stop = function() {
    if (!this._running) return;
    this._running = false;
    if (window.xeLauncher && window.xeLauncher.offXeInputEvent)
      window.xeLauncher.offXeInputEvent();
  };

  EvdevPoller.prototype._resolve = function(action, deviceName) {
    // Chercher dans le mapping custom
    var cm = this._customMaps && this._customMaps[deviceName];
    if (cm) {
      // Le mapping stocke { action_id: raw_key_captured }
      // ex: { confirm: 'Enter', up: 'ArrowUp', ... } (clavier)
      // ou  { confirm: 'confirm', up: 'up', ... }     (manette via xe_input)
      // On cherche quel action_id a pour valeur cette action.
      for (var aid in cm) {
        if (cm[aid] === action) {
          var a = ACTION_KEYS.find(function(k){ return k.id === aid; });
          return a ? a.default : null;
        }
      }
      // Action non trouvée dans le mapping custom → fallback défaut
      // (le device est mappé mais cette action spécifique ne l'est pas)
      return ACTION_TO_KEY[action] || null;
    }
    // Pas de mapping custom → défaut
    return ACTION_TO_KEY[action] || null;
  };

  // Actions physiques acceptées — exclut gyroscope, touchpad, capteurs IR, axes analogiques, etc.
  var ACCEPTED_ACTIONS = {
    'up':true,'down':true,'left':true,'right':true,
    'confirm':true,'back':true,'menu':true,'select':true,
    'action':true,'l1':true,'r1':true,'l2':true,'r2':true,'l3':true,'r3':true,
  };

  EvdevPoller.prototype._onEvent = function(data) {
    if (!data || !data.action || !data.device) return;
    var action = data.action;
    var device = data.device;

    // Ignorer tout ce qui n'est pas un bouton reconnu (gyroscope, touchpad, IR, axes…)
    if (!ACCEPTED_ACTIONS[action]) return;

    // Debug
    if (this.debugMode && this.onDebug) this.onDebug({ raw: action, device: device });

    // Notifier le mapper brut (avant résolution)
    if (this.onRawEvent) this.onRawEvent(action, device);

    // Navigation normale : résoudre et envoyer la touche logique
    var key = this._resolve(action, device);
    if (key) this.onKey(key);
  };

  /* ================================================================
   * Input Mapper
   * ================================================================ */
  var ACTION_KEYS = [
    { id:'up',      label:'Haut',      default:'ArrowUp'    },
    { id:'down',    label:'Bas',       default:'ArrowDown'  },
    { id:'left',    label:'Gauche',    default:'ArrowLeft'  },
    { id:'right',   label:'Droite',    default:'ArrowRight' },
    { id:'confirm', label:'Confirmer', default:'Enter'      },
    { id:'back',    label:'Retour',    default:'Escape'     },
    { id:'menu',    label:'Menu',      default:'Start'      },
    { id:'action',  label:'Action',    default:'Triangle'   },
  ];

  function InputMapper(storageKey) {
    this.storageKey = storageKey || 'xelauncher_inputmaps';
    this._maps = this._load();
  }
  InputMapper.prototype._load = function() {
    try { return JSON.parse(localStorage.getItem(this.storageKey) || '{}'); } catch(e) { return {}; }
  };
  InputMapper.prototype.save = function(d, m) {
    this._maps[d] = m;
    try { localStorage.setItem(this.storageKey, JSON.stringify(this._maps)); } catch(e) {}
  };
  InputMapper.prototype.get      = function(d) { return this._maps[d] || null; };
  InputMapper.prototype.has      = function(d) { return !!this._maps[d]; };
  InputMapper.prototype.clearAll = function() { this._maps = {}; localStorage.removeItem(this.storageKey); };
  InputMapper.prototype.getDefault = function() {
    var m = {};
    ACTION_KEYS.forEach(function(a) { m[a.id] = a.default; });
    return m;
  };
  InputMapper.prototype.resolveKey = function(deviceId, rawKey) {
    if (deviceId === '__keyboard__') return rawKey;
    var map = this._maps[deviceId];
    if (!map) return rawKey;
    for (var actionId in map) {
      if (map[actionId] === rawKey) {
        var a = ACTION_KEYS.find(function(k) { return k.id === actionId; });
        return a ? a.default : rawKey;
      }
    }
    // Mapping existe mais cette action n'y est pas → fallback défaut
    var defaultAction = ACTION_KEYS.find(function(k) { return k.id === rawKey; });
    return defaultAction ? defaultAction.default : rawKey;
  };

  /* ================================================================
   * Remote/Mouse Capture - Convertir mouvements souris en touches
   * ================================================================ */
  function RemoteCapture(onKey, mapperGetter) {
    this.onKey = onKey;
    this.mapperGetter = mapperGetter;
    this.deviceId = null;
    this.active = false;
    this.lastX = 0;
    this.lastY = 0;
    this.threshold = 15;
    this.cooldown = 150;
    this.lastMoveTime = 0;
    this.lastKeyTime = 0;
    
    this._handler = this._onMouseMove.bind(this);
    this._keyHandler = this._onKeyDown.bind(this);
    this._preventHandler = this._preventDefault.bind(this);
  }

  RemoteCapture.prototype.start = function(deviceId) {
    if (this.active) return;
    this.deviceId = deviceId || 'remote_device';
    this.active = true;
    document.addEventListener('mousemove', this._handler);
    document.addEventListener('keydown', this._keyHandler);
    document.addEventListener('click', this._preventHandler, true);
    document.addEventListener('mousedown', this._preventHandler, true);
    document.body.style.cursor = 'none';
  };

  RemoteCapture.prototype.stop = function() {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener('mousemove', this._handler);
    document.removeEventListener('keydown', this._keyHandler);
    document.removeEventListener('click', this._preventHandler, true);
    document.removeEventListener('mousedown', this._preventHandler, true);
    document.body.style.cursor = '';
  };

  RemoteCapture.prototype._preventDefault = function(e) {
    // Ne bloquer que si on est dans l'app (pas en configuration)
    if (!document.getElementById('mapperOverlay')?.classList.contains('visible')) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  RemoteCapture.prototype._onMouseMove = function(e) {
    if (!this.active) return;
    
    const now = Date.now();
    if (now - this.lastMoveTime < this.cooldown) return;
    
    const dx = e.movementX;
    const dy = e.movementY;
    
    if (Math.abs(dx) < this.threshold && Math.abs(dy) < this.threshold) return;
    
    let key = null;
    if (Math.abs(dx) > Math.abs(dy)) {
      key = dx > 0 ? 'ArrowRight' : 'ArrowLeft';
    } else {
      key = dy > 0 ? 'ArrowDown' : 'ArrowUp';
    }
    
    if (key) {
      this.lastMoveTime = now;
      const mapper = this.mapperGetter();
      const resolved = mapper ? (mapper.resolveKey(this.deviceId, key) || key) : key;
      this.onKey(resolved);
    }
  };

  RemoteCapture.prototype._onKeyDown = function(e) {
    if (!this.active) return;

    const now = Date.now();
    if (now - this.lastKeyTime < 50) return;

    const key = e.key;
    const mapperEl = document.getElementById('mapperOverlay');
    const isMapper = mapperEl && mapperEl.classList.contains('visible');

    if (isMapper) {
      // Pendant le mapping : toutes les touches, valeur brute (pas de resolveKey)
      this.lastKeyTime = now;
      e.preventDefault();
      e.stopPropagation();
      this.onKey(key);
      return;
    }

    // Navigation normale : touches connues + résolution du mapping
    const remoteKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', ' '];
    if (remoteKeys.includes(key)) {
      this.lastKeyTime = now;
      e.preventDefault();
      e.stopPropagation();
      var mapper = this.mapperGetter();
      var resolved = mapper ? (mapper.resolveKey(this.deviceId, key) || key) : key;
      this.onKey(resolved);
    }
  };

  /* ================================================================
   * Wake lock & Toast
   * ================================================================ */
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

  function Toast(el) { this.el = el; this._t = null; }
  Toast.prototype.show = function(msg, isError, duration) {
    if (!this.el) return;
    this.el.textContent = msg;
    this.el.className = 'toast show' + (isError ? ' error' : '');
    if (this._t) clearTimeout(this._t);
    var el = this.el;
    if (!isError) this._t = setTimeout(function() { el.classList.remove('show'); }, duration || 2500);
  };
  Toast.prototype.hide = function() {
    if (this.el) this.el.classList.remove('show');
    if (this._t) clearTimeout(this._t);
  };

  /* ================================================================
   * GP_DEFAULT — mapping par défaut pour manette générique
   * Correspond aux valeurs default de ACTION_KEYS
   * ================================================================ */
  var GP_DEFAULT = {
    up:      'ArrowUp',
    down:    'ArrowDown',
    left:    'ArrowLeft',
    right:   'ArrowRight',
    confirm: 'Enter',
    back:    'Escape',
    menu:    'Start',
    action:  'Triangle',
  };

  /* ================================================================
   * Expose
   * ================================================================ */
  root.XeInput = {
    VirtualKeyboard,

    InputMapper,
    EvdevPoller,
    RemoteCapture,
    ACTION_KEYS,
    requestWakeLock,
    Toast,
    ACCENTS,
    getLayoutPref,
    setLayoutPref,
    GP_DEFAULT,
    prettyRaw,
  };

})(typeof window !== 'undefined' ? window : this);