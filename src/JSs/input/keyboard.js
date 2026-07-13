/**
 * keyboard.js
 * VirtualKeyboard — clavier virtuel QWERTY/AZERTY avec modes
 * letters / nums / specials / url, menu accent, navigation manette.
 */

;(function(root) {
  'use strict';

  /* ── Layouts ── */
  var QWERTY = {
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

  var AZERTY = {
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

  var URL_NUMS = [
    ['7','8','9',null,null,null,null,null,null,null],
    ['4','5','6',null,null,null,null,null,null,null],
    ['1','2','3',null,null,null,null,null,null,null],
    ['0','.',':',null,null,null,null,null,null,null],
  ];
  var URL_SPECIALS = [
    ['-','_','~','.','/','?','#','[',']','@'],
    ['!','$','&','\'','(',')','*','+',',',';'],
    [null,'=','%',null,null,null,null,null,null,null],
  ];

  var BOTTOM_NORMAL = [
    { label:'MAJ',    col:0, span:2, action:'shift' },
    { label:'ESPACE', col:2, span:4, action:'space' },
    { label:'\u232b', col:6, span:2, action:'back'  },
    { label:'OK',     col:8, span:2, action:'ok'    },
  ];
  var BOTTOM_URL = [
    { label:'\u232b', col:0, span:4, action:'back' },
    { label:'OK',     col:6, span:4, action:'ok'   },
  ];

  var MODES_NORMAL  = ['letters','nums','specials'];
  var LABELS_NORMAL = ['A-Z','0-9','!@#'];
  var MODES_URL     = ['letters','nums','specials'];
  var LABELS_URL    = ['a-z','0-9',':/'];
  var KB_COLS       = 10;

  /* ── Constructeur ── */
  function VirtualKeyboard(containerEl, displayEl, modesEl, type) {
    this.container = containerEl;
    this.display   = displayEl;
    this.modes     = modesEl;
    this.type      = (type === 'url') ? 'url' : 'normal';
    this.mode      = 'letters';
    this.caps      = false;
    this._capsLastPress = 0;
    this.section   = 'kb';
    this.topFocus  = 0;
    this.row       = 0;
    this.col       = 0;
    this.value     = '';
    this.onConfirm = null;
    this.onCancel  = null;
    this._accentKey       = null;
    this._accentIndex     = -1;
    this._accentTargetBtn = null;
    this._renderScheduled = false;
    this._render();
  }

  /* ── Helpers internes ── */
  VirtualKeyboard.prototype._getLayouts = function() {
    var base = root._XeUtils.getLayoutPref() === 'qwerty' ? QWERTY : AZERTY;
    if (this.type === 'url') return { letters: base.letters, nums: URL_NUMS, specials: URL_SPECIALS };
    return base;
  };
  VirtualKeyboard.prototype._getModeNames  = function() { return this.type === 'url' ? MODES_URL    : MODES_NORMAL;  };
  VirtualKeyboard.prototype._getModeLabels = function() { return this.type === 'url' ? LABELS_URL   : LABELS_NORMAL; };
  VirtualKeyboard.prototype._getBottom     = function() { return this.type === 'url' ? BOTTOM_URL   : BOTTOM_NORMAL; };

  VirtualKeyboard.prototype._rows = function() {
    var raw = this._getLayouts()[this.mode];
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

  /* ── Rendu ── */
  VirtualKeyboard.prototype._doRender = function() {
    if (!this.container) return;
    var self       = this;
    var ACCENTS    = root._XeUtils.ACCENTS;
    var rows       = this._rows();
    var bottom     = this._getBottom();
    var modeNames  = this._getModeNames();
    var modeLabels = this._getModeLabels();
    this.container.innerHTML = '';
    this._accentTargetBtn    = null;

    rows.forEach(function(row, ri) {
      var rowEl = document.createElement('div');
      rowEl.className = 'kb-row';
      row.forEach(function(key, ci) {
        var btn        = document.createElement('div');
        var isActive   = self.section === 'kb' && self.row === ri && self.col === ci;
        var hasAccent  = self.type === 'normal' && self.mode === 'letters' && key && ACCENTS[key];
        var displayKey = key;
        if (key && self.type === 'normal' && self.mode === 'letters')
          displayKey = (self.caps === true || self.caps === 'once') ? key.toUpperCase() : key;
        btn.className = 'kb-key'
          + (key === null ? ' invisible' : '')
          + (isActive     ? ' kbactive'  : '')
          + (hasAccent    ? ' has-accent': '');
        if (key !== null) btn.textContent = displayKey;
        if (isActive && self.section === 'accent' && self._accentKey === key)
          self._accentTargetBtn = btn;
        if (key !== null)
          btn.addEventListener('click', function() { self.section='kb'; self.row=ri; self.col=ci; self._pressKey(); });
        rowEl.appendChild(btn);
      });
      self.container.appendChild(rowEl);
    });

    var bottomEl = document.createElement('div');
    bottomEl.className = 'kb-row';
    var bri = rows.length;
    bottom.forEach(function(b, bi) {
      var btn      = document.createElement('div');
      var isActive = self.section === 'kb' && self.row === bri && self.col === b.col;
      btn.className = 'kb-key'
        + (b.action === 'ok'    ? ' confirm'  : '')
        + (b.action === 'shift' && (self.caps === 'once' || self.caps === true) ? ' shift-on' : '')
        + (b.action === 'shift' && self.caps === true ? ' caps-lock' : '')
        + (isActive ? ' kbactive' : '');
      btn.style.gridColumn = (b.col + 1) + '/span ' + b.span;
      btn.textContent = b.label;
      btn.addEventListener('click', function() { self.section='kb'; self.row=bri; self.col=b.col; self._pressBottom(bi); });
      bottomEl.appendChild(btn);
    });
    this.container.appendChild(bottomEl);

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

  /* ── Menu accent ── */
  VirtualKeyboard.prototype._renderAccentMenu = function() {
    var ACCENTS  = root._XeUtils.ACCENTS;
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
      item.className  = 'kb-accent-item' + (self._accentIndex >= 0 && vi === self._accentIndex ? ' kbactive' : '');
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
      var menuW = menu.offsetWidth, menuH = menu.offsetHeight;
      var left  = rect.left + rect.width / 2 - menuW / 2;
      var top   = rect.top - menuH - 10;
      left = Math.max(8, Math.min(left, window.innerWidth - menuW - 8));
      if (top < 8) top = rect.bottom + 10;
      menu.style.left = left + 'px';
      menu.style.top  = top  + 'px';
    });
  };

  VirtualKeyboard.prototype._closeAccent = function() {
    this.section = 'kb'; this._accentKey = null; this._accentTargetBtn = null;
    var existing = document.getElementById('kb-accent-popup');
    if (existing) existing.parentNode.removeChild(existing);
    this._render();
  };

  /* ── Actions touches ── */
  VirtualKeyboard.prototype._insertChar = function(ch) {
    this.value += ch;
    if (this.caps === 'once') this.caps = false;
  };

  VirtualKeyboard.prototype._pressKey = function() {
    var ACCENTS = root._XeUtils.ACCENTS;
    var rows    = this._rows();
    if (this.row === rows.length) {
      var bi = 0, col = this.col;
      this._getBottom().forEach(function(b, i) { if (col >= b.col && col < b.col + b.span) bi = i; });
      this._pressBottom(bi); return;
    }
    var key = rows[this.row][this.col];
    if (!key) return;
    var ch = key;
    if (this.type === 'normal' && this.mode === 'letters')
      ch = (this.caps === true || this.caps === 'once') ? key.toUpperCase() : key;
    if (this.type === 'normal' && this.mode === 'letters' && ACCENTS[key]) {
      if (this.section === 'accent' && this._accentKey === key) { this._closeAccent(); return; }
      if (this.section === 'accent') this.value = this.value.slice(0, -1);
      this._insertChar(ch);
      this.section = 'accent'; this._accentKey = key; this._accentIndex = -1;
      this._render(); return;
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
          if (now - this._capsLastPress < 1000 && this.caps === 'once') this.caps = true;
          else if (this.caps === true) this.caps = false;
          else this.caps = 'once';
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

  VirtualKeyboard.prototype.open = function(initialValue) {
    this.value = initialValue || ''; this.caps = false;
    this.mode = 'letters'; this.section = 'kb'; this._accentKey = null;
    this.row = 0; this.col = 0; this.topFocus = 0;
    this._render();
  };

  /* ── Navigation manette/clavier physique ── */
  VirtualKeyboard.prototype.handleKey = function(key) {
    var ACCENTS   = root._XeUtils.ACCENTS;
    var rows      = this._rows();
    var maxRow    = rows.length;
    var modeNames = this._getModeNames();
    var bottom    = this._getBottom();
    var handled   = true;

    if (this.section === 'accent') {
      var variants = ACCENTS[this._accentKey] || [];
      if      (key === 'ArrowLeft')  { this._accentIndex = this._accentIndex < 0 ? variants.length - 1 : (this._accentIndex - 1 + variants.length) % variants.length; }
      else if (key === 'ArrowRight') { this._accentIndex = (this._accentIndex + 1) % variants.length; }
      else if (key === 'Enter')      { if (this._accentIndex >= 0) this.value = this.value.slice(0, -1) + variants[this._accentIndex]; this._closeAccent(); return true; }
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

  root._XeKeyboard = { VirtualKeyboard };

})(typeof window !== 'undefined' ? window : this);
