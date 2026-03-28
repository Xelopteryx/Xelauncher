/**
 * XeLauncher — Unified Input Manager
 * Maps ALL hardware inputs (gamepad, keyboard, remote, wiimote) to keyboard events.
 * When RetroArch/Jellyfin are launched, this module becomes inactive.
 */

;(function(root) {
  'use strict';

  /* ── Keyboard layout ─────────────────────────────────────────────────── */
  const KB_LAYOUTS = {
    letters: [
      ['a','z','e','r','t','y','u','i','o','p'],
      ['q','s','d','f','g','h','j','k','l','m'],
      [null,'w','x','c','v','b','n',',','.',null]
    ],
    nums: [
      ['1','2','3','4','5','6','7','8','9','0'],
      ['!','@','#','$','%','^','&','*','(',')'],
      [null,'-','_','=','+','[',']','{','}',null]
    ]
  };
  const KB_BOTTOM = [
    {label:'MAJ',col:0,span:2},
    {label:'ESPACE',col:2,span:4},
    {label:'⌫',col:6,span:2},
    {label:'OK',col:8,span:2}
  ];
  const KB_COLS = 10;

  /* ── Virtual Keyboard ─────────────────────────────────────────────────── */
  function VirtualKeyboard(containerEl, displayEl, modesEl) {
    this.container = containerEl;
    this.display = displayEl;
    this.modes = modesEl;
    this.mode = 'letters';
    this.caps = false;
    this.section = 'kb'; // 'top' | 'kb'
    this.topFocus = 0;
    this.row = 0;
    this.col = 0;
    this.value = '';
    this.onConfirm = null;
    this.onCancel = null;
    this._render();
  }

  VirtualKeyboard.prototype._nearestCol = function(ri, col) {
    const layout = KB_LAYOUTS[this.mode];
    if (ri === layout.length) {
      let best = 0, bestD = 999;
      KB_BOTTOM.forEach(b => {
        const mid = b.col + Math.floor(b.span / 2);
        const d = Math.abs(mid - col);
        if (d < bestD) { bestD = d; best = b.col; }
      });
      return best;
    }
    const row = layout[ri];
    if (row[col] !== null) return col;
    let best = col, bestD = 999;
    for (let c = 0; c < KB_COLS; c++) {
      if (row[c] !== null) {
        const d = Math.abs(c - col);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    return best;
  };

  VirtualKeyboard.prototype._render = function() {
    if (!this.container) return;
    const layout = KB_LAYOUTS[this.mode];
    this.container.innerHTML = '';

    layout.forEach((row, ri) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'kb-row';
      row.forEach((key, ci) => {
        const btn = document.createElement('div');
        const isActive = this.section === 'kb' && this.row === ri && this.col === ci;
        btn.className = 'kb-key' +
          (key === null ? ' invisible' : '') +
          (isActive ? ' kbactive' : '');
        if (key !== null) btn.textContent = (this.caps && key.length === 1) ? key.toUpperCase() : key;
        if (key !== null) {
          btn.addEventListener('click', () => { this.section='kb'; this.row=ri; this.col=ci; this._pressKey(); });
        }
        rowEl.appendChild(btn);
      });
      this.container.appendChild(rowEl);
    });

    // Bottom row
    const bottomEl = document.createElement('div');
    bottomEl.className = 'kb-row';
    const bri = layout.length;
    KB_BOTTOM.forEach((b, bi) => {
      const btn = document.createElement('div');
      const isActive = this.section === 'kb' && this.row === bri && this.col === b.col;
      btn.className = 'kb-key' +
        (b.label === 'OK' ? ' confirm' : '') +
        (b.label === 'MAJ' && this.caps ? ' shift-on' : '') +
        (isActive ? ' kbactive' : '');
      btn.style.gridColumn = (b.col + 1) + '/span ' + b.span;
      btn.textContent = b.label;
      btn.addEventListener('click', () => {
        this.section = 'kb'; this.row = bri; this.col = b.col;
        this._pressBottom(bi);
      });
      bottomEl.appendChild(btn);
    });
    this.container.appendChild(bottomEl);

    // Mode buttons
    if (this.modes) {
      this.modes.querySelectorAll('.kb-mode-btn').forEach((btn, i) => {
        btn.className = 'kb-mode-btn' +
          (i === (this.mode === 'letters' ? 0 : 1) ? ' on' : '') +
          (this.section === 'top' && this.topFocus === i ? ' kbactive' : '');
      });
    }

    // Display
    if (this.display) {
      this.display.textContent = this.value + '|';
    }
  };

  VirtualKeyboard.prototype._pressKey = function() {
    const layout = KB_LAYOUTS[this.mode];
    if (this.row === layout.length) {
      let bi = 0;
      KB_BOTTOM.forEach((b, i) => { if (this.col >= b.col && this.col < b.col + b.span) bi = i; });
      this._pressBottom(bi);
      return;
    }
    const key = layout[this.row][this.col];
    if (key) this.value += this.caps ? key.toUpperCase() : key;
    this._render();
  };

  VirtualKeyboard.prototype._pressBottom = function(bi) {
    const lbl = KB_BOTTOM[bi].label;
    if (lbl === 'MAJ') { this.caps = !this.caps; }
    else if (lbl === 'ESPACE') { this.value += ' '; }
    else if (lbl === '⌫') { this.value = this.value.slice(0, -1); }
    else if (lbl === 'OK') {
      if (this.onConfirm) this.onConfirm(this.value);
      return;
    }
    this._render();
  };

  VirtualKeyboard.prototype.setMode = function(m) {
    this.mode = m; this.section = 'kb'; this.row = 0; this.col = this._nearestCol(0, 0);
    this._render();
  };

  VirtualKeyboard.prototype.open = function(initialValue, label) {
    this.value = initialValue || '';
    this.caps = false; this.mode = 'letters';
    this.section = 'kb'; this.row = 0; this.col = 0; this.topFocus = 0;
    if (label && this.display) {
      const lbl = this.display.previousElementSibling;
      if (lbl && lbl.classList.contains('kb-label')) lbl.textContent = label;
    }
    this._render();
  };

  VirtualKeyboard.prototype.handleKey = function(key) {
    const layout = KB_LAYOUTS[this.mode];
    const maxRow = layout.length;
    let handled = true;

    if (key === 'ArrowUp') {
      if (this.section === 'kb' && this.row === 0) this.section = 'top';
      else if (this.section === 'kb') { this.row--; this.col = this._nearestCol(this.row, this.col); }
    } else if (key === 'ArrowDown') {
      if (this.section === 'top') { this.section = 'kb'; this.row = 0; this.col = this._nearestCol(0, this.col); }
      else if (this.row < maxRow) { this.row++; this.col = this._nearestCol(this.row, this.col); }
    } else if (key === 'ArrowLeft') {
      if (this.section === 'top') { this.topFocus = (this.topFocus - 1 + 2) % 2; }
      else if (this.row === maxRow) {
        let bi = 0; KB_BOTTOM.forEach((b, i) => { if (this.col >= b.col && this.col < b.col + b.span) bi = i; });
        this.col = KB_BOTTOM[(bi - 1 + KB_BOTTOM.length) % KB_BOTTOM.length].col;
      } else {
        let nc = (this.col - 1 + KB_COLS) % KB_COLS, tr = 0;
        while (layout[this.row][nc] === null && tr < KB_COLS) { nc = (nc - 1 + KB_COLS) % KB_COLS; tr++; }
        this.col = nc;
      }
    } else if (key === 'ArrowRight') {
      if (this.section === 'top') { this.topFocus = (this.topFocus + 1) % 2; }
      else if (this.row === maxRow) {
        let bi = 0; KB_BOTTOM.forEach((b, i) => { if (this.col >= b.col && this.col < b.col + b.span) bi = i; });
        this.col = KB_BOTTOM[(bi + 1) % KB_BOTTOM.length].col;
      } else {
        let nc = (this.col + 1) % KB_COLS, tr = 0;
        while (layout[this.row][nc] === null && tr < KB_COLS) { nc = (nc + 1) % KB_COLS; tr++; }
        this.col = nc;
      }
    } else if (key === 'Enter') {
      if (this.section === 'top') this.setMode(this.topFocus === 0 ? 'letters' : 'nums');
      else this._pressKey();
    } else if (key === 'Escape') {
      if (this.onCancel) this.onCancel();
    } else { handled = false; }

    if (handled) this._render();
    return handled;
  };

  /* ── Gamepad poller ───────────────────────────────────────────────────── */
  const GAMEPAD_MAP = {
    0: 'Enter',    // Cross/A
    1: 'Escape',   // Circle/B
    2: 'Square',   // Square/X
    3: 'Triangle', // Triangle/Y
    4: 'L1',
    5: 'R1',
    6: 'L2',
    7: 'R2',
    8: 'Select',   // Share/Back
    9: 'Start',    // Options/Menu
    12: 'ArrowUp',
    13: 'ArrowDown',
    14: 'ArrowLeft',
    15: 'ArrowRight',
  };

  function GamepadPoller(onKey) {
    this.onKey = onKey;
    this.state = {};
    this._running = false;
    this._frame = null;
  }

  GamepadPoller.prototype.start = function() {
    if (this._running) return;
    this._running = true;
    this._poll();
  };

  GamepadPoller.prototype.stop = function() {
    this._running = false;
    if (this._frame) cancelAnimationFrame(this._frame);
  };

  GamepadPoller.prototype._poll = function() {
    if (!this._running) return;
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < gps.length; i++) {
      const gp = gps[i];
      if (!gp) continue;
      if (!this.state[i]) this.state[i] = { buttons: [], acH: false, acV: false };
      const st = this.state[i];

      gp.buttons.forEach((btn, idx) => {
        const p = btn.pressed, w = st.buttons[idx];
        if (p && !w && GAMEPAD_MAP[idx]) this.onKey(GAMEPAD_MAP[idx]);
        st.buttons[idx] = p;
      });

      const T = 0.4;
      let axH = 0, axV = 0;
      if (Math.abs(gp.axes[0]) > T) axH = gp.axes[0];
      else if (gp.axes[6] !== undefined && Math.abs(gp.axes[6]) > T) axH = gp.axes[6];
      if (Math.abs(gp.axes[1]) > T) axV = gp.axes[1];
      else if (gp.axes[7] !== undefined && Math.abs(gp.axes[7]) > T) axV = gp.axes[7];

      if (!st.acH) {
        if (axH < -T) { this.onKey('ArrowLeft'); st.acH = true; setTimeout(() => { st.acH = false; }, 180); }
        else if (axH > T) { this.onKey('ArrowRight'); st.acH = true; setTimeout(() => { st.acH = false; }, 180); }
      }
      if (axH === 0) st.acH = false;
      if (!st.acV) {
        if (axV < -T) { this.onKey('ArrowUp'); st.acV = true; setTimeout(() => { st.acV = false; }, 180); }
        else if (axV > T) { this.onKey('ArrowDown'); st.acV = true; setTimeout(() => { st.acV = false; }, 180); }
      }
      if (axV === 0) st.acV = false;
    }
    this._frame = requestAnimationFrame(() => this._poll());
  };

  /* ── Input Mapper ─────────────────────────────────────────────────────── */
  // ACTION_KEYS: the conceptual actions we need to map
  const ACTION_KEYS = [
    { id: 'up',       label: '↑ Haut',        default: 'ArrowUp' },
    { id: 'down',     label: '↓ Bas',          default: 'ArrowDown' },
    { id: 'left',     label: '← Gauche',       default: 'ArrowLeft' },
    { id: 'right',    label: '→ Droite',        default: 'ArrowRight' },
    { id: 'confirm',  label: '✓ Confirmer',    default: 'Enter' },
    { id: 'back',     label: '✕ Retour',       default: 'Escape' },
    { id: 'menu',     label: '☰ Menu',         default: 'Start' },
    { id: 'action',   label: '△ Action',       default: 'Triangle' },
  ];

  function InputMapper(storageKey) {
    this.storageKey = storageKey || 'xelauncher_inputmaps';
    this._maps = this._load();
  }

  InputMapper.prototype._load = function() {
    try { return JSON.parse(localStorage.getItem(this.storageKey) || '{}'); }
    catch(e) { return {}; }
  };

  InputMapper.prototype.save = function(deviceId, mapping) {
    this._maps[deviceId] = mapping;
    try { localStorage.setItem(this.storageKey, JSON.stringify(this._maps)); } catch(e) {}
  };

  InputMapper.prototype.get = function(deviceId) {
    return this._maps[deviceId] || null;
  };

  InputMapper.prototype.has = function(deviceId) {
    return !!this._maps[deviceId];
  };

  InputMapper.prototype.getDefault = function() {
    const m = {};
    ACTION_KEYS.forEach(a => { m[a.id] = a.default; });
    return m;
  };

  InputMapper.prototype.resolveKey = function(deviceId, rawKey) {
    // If keyboard — just pass through (keyboard is always identity mapped)
    if (deviceId === '__keyboard__') return rawKey;
    const map = this._maps[deviceId];
    if (!map) return rawKey;
    // Find action whose raw input matches rawKey
    for (const actionId of Object.keys(map)) {
      if (map[actionId] === rawKey) {
        // Return the default keyboard key for this action
        const a = ACTION_KEYS.find(k => k.id === actionId);
        return a ? a.default : rawKey;
      }
    }
    return null; // unmapped → ignore
  };

  /* ── Wake lock (screen stay-on) ──────────────────────────────────────── */
  let _wakeLock = null;
  async function requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        _wakeLock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', async () => {
          if (document.visibilityState === 'visible' && _wakeLock === null) {
            _wakeLock = await navigator.wakeLock.request('screen');
          }
        });
      } catch(e) { /* ignore */ }
    }
  }

  /* ── Toast utility ───────────────────────────────────────────────────── */
  function Toast(el) {
    this.el = el;
    this._t = null;
  }
  Toast.prototype.show = function(msg, isError, duration) {
    if (!this.el) return;
    this.el.textContent = msg;
    this.el.className = 'toast show' + (isError ? ' error' : '');
    if (this._t) clearTimeout(this._t);
    if (!isError) this._t = setTimeout(() => { this.el.classList.remove('show'); }, duration || 2500);
  };
  Toast.prototype.hide = function() {
    if (this.el) this.el.classList.remove('show');
    if (this._t) clearTimeout(this._t);
  };

  /* ── Expose ──────────────────────────────────────────────────────────── */
  root.XeInput = {
    VirtualKeyboard,
    GamepadPoller,
    InputMapper,
    ACTION_KEYS,
    requestWakeLock,
    Toast
  };

})(typeof window !== 'undefined' ? window : this);
