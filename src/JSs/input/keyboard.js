/**
 * keyboard.js
 * VirtualKeyboard — UN SEUL clavier virtuel complet (AZERTY/QWERTY).
 *
 * Changement majeur : suppression des 3 modes séparés (letters/nums/specials).
 * Tout est désormais visible sur la même grille : chiffres, lettres et les
 * symboles les plus courants. Les symboles rares (& ~ # { } [ ] | ` \ ^ + =
 * ¡ ¿ …) restent accessibles, mais via le même menu de variantes qui gère
 * déjà les accents — au lieu d'un clavier "!@#" caché derrière un bouton
 * de mode.
 *
 * Navigation en mode "accent" (menu de variantes affiché après avoir tapé
 * une lettre/symbole qui en possède) :
 *   Tant qu'on n'a pas explicitement "activé" le menu, Gauche/Droite se
 *   comportent comme en navigation normale (ferment le menu, gardent la
 *   lettre de base, ET continuent le déplacement) — pour ne jamais gêner
 *   la frappe rapide.
 *   Haut          ? active le menu (le "parcours" des variantes commence)
 *   Gauche/Droite (une fois activé) ? parcourt les variantes
 *   Entrée        ? valide la variante sélectionnée
 *   Bas / Échap   ? ferme le menu et garde la lettre de base
 *
 * La casse (Maj) au moment où le menu s'ouvre est mémorisée et appliquée
 * à la variante choisie, y compris en verrouillage Maj permanent.
 */

;(function(root) {
  'use strict';

  /* -- Layouts complets : 5 rangées x 10 colonnes, aucune case vide -- */
  var AZERTY_FULL = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['a','z','e','r','t','y','u','i','o','p'],
    ['q','s','d','f','g','h','j','k','l','m'],
    ['w','x','c','v','b','n',',',';',':','!'],
    ['\'','"','(',')','-','_','@','.','/','?'],
  ];

  var QWERTY_FULL = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l',';'],
    ['z','x','c','v','b','n','m',',','.','!'],
    ['\'','"','(',')','-','_','@',':','/','?'],
  ];

  var BOTTOM_ROW = [
    { label:'MAJ',    col:0, span:2, action:'shift' },
    { label:'ESPACE', col:2, span:4, action:'space' },
    { label:'\u232b', col:6, span:2, action:'back'  },
    { label:'OK',     col:8, span:2, action:'ok'    },
  ];

  var KB_COLS = 10;

  /* Anti-rebond minimal entre deux appuis sur la rangée du bas
     (Maj/Espace/Retour/OK) : évite qu'un seul appui physique reçu en
     double (rebond matériel, répétition evdev) ne soit interprété comme
     deux appuis distincts — ce qui déclenchait notamment un verrouillage
     Maj accidentel via le double-appui rapide. */
  var BOTTOM_DEBOUNCE_MS = 150;

  /* -- Constructeur --
   * (containerEl, displayEl, type) — le 3e paramètre "modesEl" a été
   * retiré : il n'y a plus de boutons de mode à surveiller. */
  function VirtualKeyboard(containerEl, displayEl, type) {
    this.container = containerEl;
    this.display   = displayEl;
    this.type      = type || 'normal';
    this.caps      = false;
    this._capsLastPress = 0;
    this.section   = 'kb';
    this.row       = 0;
    this.col       = 0;
    this.value     = '';
    this.onConfirm = null;
    this.onCancel  = null;
    this._accentKey       = null;
    this._accentIndex     = -1;
    this._accentBrowsing  = false;
    this._accentUpper     = false; /* casse figée au moment où le menu s'ouvre */
    this._accentTargetBtn = null;
    this._renderScheduled = false;
    this._lastBottomPress = 0;
    this._render();
  }

  VirtualKeyboard.prototype._layout = function() {
    return root._XeUtils.getLayoutPref() === 'qwerty' ? QWERTY_FULL : AZERTY_FULL;
  };

  VirtualKeyboard.prototype._isLetter = function(k) { return !!k && /^[a-z]$/i.test(k); };

  VirtualKeyboard.prototype._nearestCol = function(ri, col) {
    var rows = this._layout();
    if (ri === rows.length) {
      var best = BOTTOM_ROW[0].col, bestD = 999;
      BOTTOM_ROW.forEach(function(b) {
        var mid = b.col + Math.floor(b.span / 2);
        var d   = Math.abs(mid - col);
        if (d < bestD) { bestD = d; best = b.col; }
      });
      return best;
    }
    var row = rows[ri];
    if (row[col] != null) return col;
    var bestC = col, bestDC = 999;
    for (var c = 0; c < KB_COLS; c++) {
      if (row[c] != null) {
        var dc = Math.abs(c - col);
        if (dc < bestDC) { bestDC = dc; bestC = c; }
      }
    }
    return bestC;
  };

  /* -- Rendu -- */
  VirtualKeyboard.prototype._doRender = function() {
    if (!this.container) return;
    var self    = this;
    var ACCENTS = root._XeUtils.ACCENTS;
    var rows    = this._layout();
    this.container.innerHTML = '';
    this._accentTargetBtn    = null;

    rows.forEach(function(row, ri) {
      var rowEl = document.createElement('div');
      rowEl.className = 'kb-row';
      row.forEach(function(key, ci) {
        var btn         = document.createElement('div');
        var isActive       = self.section === 'kb'     && self.row === ri && self.col === ci;
        /* Case ciblée pendant que le menu de variantes est ouvert : row/col
           n'ont pas bougé depuis l'ouverture, donc c'est toujours la même
           cellule — on la garde en surbrillance et c'est elle qui sert de
           point d'ancrage pour positionner le popup. */
        var isAccentTarget = self.section === 'accent' && self.row === ri && self.col === ci;
        var isLetter    = self._isLetter(key);
        var hasVariants = !!(key && ACCENTS[key]);
        var displayKey  = key;
        if (isLetter) displayKey = (self.caps === true || self.caps === 'once') ? key.toUpperCase() : key;
        btn.className = 'kb-key'
          + (key == null                      ? ' invisible'  : '')
          + ((isActive || isAccentTarget)     ? ' kbactive'   : '')
          + (hasVariants                      ? ' has-accent' : '');
        if (key != null) btn.textContent = displayKey;
        if (isAccentTarget && self._accentKey === key) self._accentTargetBtn = btn;
        if (key != null) btn.addEventListener('click', function() { self.section = 'kb'; self.row = ri; self.col = ci; self._pressKey(); });
        rowEl.appendChild(btn);
      });
      self.container.appendChild(rowEl);
    });

    var bottomEl = document.createElement('div');
    bottomEl.className = 'kb-row';
    var bri = rows.length;
    BOTTOM_ROW.forEach(function(b, bi) {
      var btn      = document.createElement('div');
      var isActive = self.section === 'kb' && self.row === bri && self.col === b.col;
      btn.className = 'kb-key'
        + (b.action === 'ok' ? ' confirm' : '')
        + (b.action === 'shift' && (self.caps === 'once' || self.caps === true) ? ' shift-on'  : '')
        + (b.action === 'shift' && self.caps === true ? ' caps-lock' : '')
        + (isActive ? ' kbactive' : '');
      btn.style.gridColumn = (b.col + 1) + '/span ' + b.span;
      btn.textContent = b.label;
      btn.addEventListener('click', function() { self.section = 'kb'; self.row = bri; self.col = b.col; self._pressBottom(bi); });
      bottomEl.appendChild(btn);
    });
    this.container.appendChild(bottomEl);

    if (this.display) this.display.textContent = this.value + '|';
    this._renderAccentMenu();
  };

  VirtualKeyboard.prototype._render = function() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    var self = this;
    requestAnimationFrame(function() { self._renderScheduled = false; self._doRender(); });
  };

  /* -- Menu de variantes (accents ET symboles rares) --
   * Le popup est conservé d'un rendu à l'autre tant qu'il concerne la
   * même touche : on se contente de mettre à jour la surbrillance de
   * l'élément sélectionné, sans retirer/recréer le DOM ni recalculer sa
   * position — ce qui évite le flash visible lors du parcours au clavier. */
  VirtualKeyboard.prototype._renderAccentMenu = function() {
    var ACCENTS  = root._XeUtils.ACCENTS;
    var existing = document.getElementById('kb-accent-popup');

    if (this.section !== 'accent' || !this._accentKey) {
      if (existing) existing.parentNode.removeChild(existing);
      return;
    }

    var variants = ACCENTS[this._accentKey] || [];
    if (!variants.length) {
      if (existing) existing.parentNode.removeChild(existing);
      return;
    }

    var self = this;

    if (existing && existing.dataset.accentKey === this._accentKey) {
      Array.prototype.forEach.call(existing.children, function(item, vi) {
        item.classList.toggle('kbactive', self._accentIndex >= 0 && vi === self._accentIndex);
      });
      return;
    }

    if (existing) existing.parentNode.removeChild(existing);

    var menu = document.createElement('div');
    menu.id        = 'kb-accent-popup';
    menu.className = 'kb-accent-menu';
    menu.dataset.accentKey = this._accentKey;
    menu.style.position = 'fixed';
    menu.style.zIndex   = '99999';
    variants.forEach(function(v, vi) {
      var item = document.createElement('div');
      item.className   = 'kb-accent-item' + (self._accentIndex >= 0 && vi === self._accentIndex ? ' kbactive' : '');
      item.textContent = self._accentUpper ? v.toUpperCase() : v;
      item.addEventListener('click', function() {
        var chosen = self._accentUpper ? v.toUpperCase() : v;
        self.value = self.value.slice(0, -1) + chosen;
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
    this._accentBrowsing = false; this._accentUpper = false;
    var existing = document.getElementById('kb-accent-popup');
    if (existing) existing.parentNode.removeChild(existing);
    this._render();
  };

  /* -- Actions touches -- */
  VirtualKeyboard.prototype._insertChar = function(ch) {
    this.value += ch;
    if (this.caps === 'once') this.caps = false;
  };

  VirtualKeyboard.prototype._pressKey = function() {
    var ACCENTS = root._XeUtils.ACCENTS;
    var rows    = this._layout();
    if (this.row === rows.length) {
      var bi = 0, col = this.col;
      BOTTOM_ROW.forEach(function(b, i) { if (col >= b.col && col < b.col + b.span) bi = i; });
      this._pressBottom(bi); return;
    }
    var key = rows[this.row][this.col];
    if (key == null) return;
    var isLetter = this._isLetter(key);
    var ch = isLetter ? ((this.caps === true || this.caps === 'once') ? key.toUpperCase() : key) : key;

    if (ACCENTS[key]) {
      /* Touche accentuable OU symbole avec variantes : on tape la
         valeur de base tout de suite, et on ouvre le menu de choix.
         On mémorise la casse AVANT insertion : _insertChar consomme le
         Maj ponctuel ('once'), donc il faut la capturer maintenant pour
         pouvoir l'appliquer plus tard à la variante choisie. */
      if (this.section === 'accent' && this._accentKey === key) { this._closeAccent(); return; }
      if (this.section === 'accent') this.value = this.value.slice(0, -1);
      var wasUpper = (this.caps === true || this.caps === 'once');
      this._insertChar(ch);
      this.section = 'accent'; this._accentKey = key; this._accentIndex = -1;
      this._accentBrowsing = false; this._accentUpper = wasUpper;
      this._render(); return;
    }
    if (this.section === 'accent') this._closeAccent();
    this._insertChar(ch);
    this._render();
  };

  VirtualKeyboard.prototype._pressBottom = function(bi) {
    var b = BOTTOM_ROW[bi];
    if (!b) return;
    var now = Date.now();
    if (now - this._lastBottomPress < BOTTOM_DEBOUNCE_MS) return; /* anti-rebond */
    this._lastBottomPress = now;
    switch (b.action) {
      case 'shift':
        if (now - this._capsLastPress < 1000 && this.caps === 'once') this.caps = true;
        else if (this.caps === true) this.caps = false;
        else this.caps = 'once';
        this._capsLastPress = now;
        break;
      case 'space': this.value += ' '; break;
      case 'back':  this.value = this.value.slice(0, -1); break;
      case 'ok':
        if (this.onConfirm) this.onConfirm(this.value);
        return;
    }
    this._render();
  };

  /**
   * Réinitialise et ouvre le clavier avec une valeur initiale.
   * Remplace l'ancien pattern "définir mode/section/row/col à la main"
   * utilisé dans profiles.js — un seul appel suffit désormais.
   */
  VirtualKeyboard.prototype.open = function(initialValue) {
    this.value = initialValue || ''; this.caps = false;
    this.section = 'kb'; this._accentKey = null;
    this._accentBrowsing = false; this._accentUpper = false;
    this.row = 0; this.col = 0;
    this._render();
  };

  /* -- Navigation manette/clavier physique -- */
  VirtualKeyboard.prototype.handleKey = function(key) {
    var ACCENTS = root._XeUtils.ACCENTS;
    var rows    = this._layout();
    var maxRow  = rows.length;
    var handled = true;

    if (this.section === 'accent') {
      var variants = ACCENTS[this._accentKey] || [];

      if (!this._accentBrowsing) {
        /* Le menu est affiché mais pas encore "activé". Tant qu'on n'a
           pas explicitement demandé à le parcourir (flèche Haut),
           Gauche/Droite continuent de se comporter comme en navigation
           normale — on ne veut jamais piéger la frappe rapide. */
        if (key === 'ArrowUp') {
          this._accentBrowsing = true;
          this._accentIndex    = 0;
          this._render();
          return true;
        }
        if (key === 'ArrowDown' || key === 'Escape') {
          this._closeAccent();
          return true;
        }
        if (key === 'Enter') {
          /* Rien à valider tant qu'on n'a pas parcouru le menu : on
             garde simplement la lettre de base déjà tapée. */
          this._closeAccent();
          return true;
        }
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          this._closeAccent();
          return this.handleKey(key);
        }
        return false;
      }

      /* Menu activé : Gauche/Droite parcourent les variantes. */
      if (key === 'ArrowLeft') {
        this._accentIndex = (this._accentIndex - 1 + variants.length) % variants.length;
        this._render();
        return true;
      }
      if (key === 'ArrowRight') {
        this._accentIndex = (this._accentIndex + 1) % variants.length;
        this._render();
        return true;
      }
      if (key === 'Enter') {
        if (this._accentIndex >= 0) {
          var v = variants[this._accentIndex];
          if (this._accentUpper) v = v.toUpperCase();
          this.value = this.value.slice(0, -1) + v;
        }
        this._closeAccent();
        return true;
      }
      if (key === 'ArrowDown' || key === 'Escape') {
        this._closeAccent();
        return true;
      }
      /* ArrowUp en cours de parcours : rien de plus à activer. */
      return true;
    }

    if (key === 'ArrowUp') {
      if (this.row > 0) { this.row--; this.col = this._nearestCol(this.row, this.col); }
    } else if (key === 'ArrowDown') {
      if (this.row < maxRow) { this.row++; this.col = this._nearestCol(this.row, this.col); }
    } else if (key === 'ArrowLeft') {
      if (this.row === maxRow) {
        var biL = 0, colL = this.col;
        BOTTOM_ROW.forEach(function(b, i) { if (colL >= b.col && colL < b.col + b.span) biL = i; });
        this.col = BOTTOM_ROW[(biL - 1 + BOTTOM_ROW.length) % BOTTOM_ROW.length].col;
      } else {
        var ncL = (this.col - 1 + KB_COLS) % KB_COLS, trL = 0;
        while (rows[this.row][ncL] == null && trL < KB_COLS) { ncL = (ncL - 1 + KB_COLS) % KB_COLS; trL++; }
        this.col = ncL;
      }
    } else if (key === 'ArrowRight') {
      if (this.row === maxRow) {
        var biR = 0, colR = this.col;
        BOTTOM_ROW.forEach(function(b, i) { if (colR >= b.col && colR < b.col + b.span) biR = i; });
        this.col = BOTTOM_ROW[(biR + 1) % BOTTOM_ROW.length].col;
      } else {
        var ncR = (this.col + 1) % KB_COLS, trR = 0;
        while (rows[this.row][ncR] == null && trR < KB_COLS) { ncR = (ncR + 1) % KB_COLS; trR++; }
        this.col = ncR;
      }
    } else if (key === 'Enter') {
      this._pressKey();
    } else if (key === 'Escape') {
      if (this.onCancel) this.onCancel();
    } else { handled = false; }

    if (handled) this._render();
    return handled;
  };

  root._XeKeyboard = { VirtualKeyboard };

})(typeof window !== 'undefined' ? window : this);