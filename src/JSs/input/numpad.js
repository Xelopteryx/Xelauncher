/**
 * numpad.js
 * NumericKeyboard - pave numerique minimal pour saisir des adresses IPv4
 * (IP, masque, passerelle, DNS).
 *
 * Touches : 0-9, point, effacer, Entree. Rien d'autre.
 *
 * Saisie "intelligente" :
 *   - Un point est ajoute AUTOMATIQUEMENT apres 3 chiffres (3 points maximum :
 *     192.168.1.194 se tape en 192168 1 194).
 *   - Ce point automatique disparait en meme temps que le chiffre qui le
 *     precede quand on efface (un seul appui sur effacer : "192." -> "19").
 *     Un point tape a la main apres 1 ou 2 chiffres ("10.") s'efface seul.
 *   - Point ignore s'il est en double, en tete, ou au-dela du 3e.
 *   - Un nombre > 255 dans un segment est refuse, et un zero de tete est
 *     remplace par le chiffre suivant (pas de "01").
 *   - Si le champ s'ouvre avec une valeur, elle est "selectionnee"
 *     (surlignee) : le premier chiffre tape la remplace en entier, alors
 *     que "effacer" ne retire que le dernier caractere. Pratique pour
 *     retaper "24" a la place de "255.255.255.0".
 *
 * Navigation : fleches + Entree sur la touche. "Triangle" (bouton Action)
 * sert de raccourci "effacer". Echap annule.
 *
 * API compatible avec VirtualKeyboard : open(initial), handleKey(key),
 * onConfirm(value), onCancel().
 */

;(function(root) {
  'use strict';

  var LAYOUT = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['.', '0', 'back'],
  ];
  var OK_ROW = LAYOUT.length;   /* rangee supplementaire : bouton Entree */
  var COLS   = 3;

  var KEY_STYLE = 'height:clamp(46px,7.5vh,78px);font-size:clamp(18px,2.6vw,34px)';

  function NumericKeyboard(containerEl, displayEl) {
    this.container = containerEl;
    this.display   = displayEl;
    this.value     = '';
    this.fresh     = false;
    this.row       = 0;
    this.col       = 0;
    this._lastCol  = 0;
    this.onConfirm = null;
    this.onCancel  = null;
    this._render();
  }

  /* -- Ouverture -- */
  NumericKeyboard.prototype.open = function(initialValue) {
    this.value    = String(initialValue || '');
    this.fresh    = this.value.length > 0;
    this.row      = 0;
    this.col      = 0;
    this._lastCol = 0;
    this._render();
  };

  /* -- Saisie -- */
  NumericKeyboard.prototype._typeDigit = function(d) {
    if (this.fresh) { this.value = ''; this.fresh = false; }
    var segs = this.value.split('.');
    var cur  = segs[segs.length - 1];
    var next = (cur === '0') ? d : cur + d;
    if (next.length > 3 || parseInt(next, 10) > 255) return;
    segs[segs.length - 1] = next;
    this.value = segs.join('.');
    if (next.length === 3 && segs.length < 4) this.value += '.';
  };

  NumericKeyboard.prototype._typeDot = function() {
    if (this.fresh) return;
    if (!this.value || this.value.charAt(this.value.length - 1) === '.') return;
    if (this.value.split('.').length >= 4) return;
    this.value += '.';
  };

  NumericKeyboard.prototype._backspace = function() {
    this.fresh = false;
    if (!this.value) return;
    if (this.value.charAt(this.value.length - 1) === '.') {
      var before  = this.value.slice(0, -1);
      var lastSeg = before.split('.').pop();
      /* Segment complet de 3 chiffres => le point etait automatique :
         il part avec son chiffre. Sinon c'etait un point tape a la main. */
      this.value = (lastSeg.length === 3) ? before.slice(0, -1) : before;
    } else {
      this.value = this.value.slice(0, -1);
    }
  };

  NumericKeyboard.prototype._currentKey = function() {
    return this.row === OK_ROW ? 'ok' : LAYOUT[this.row][this.col];
  };

  NumericKeyboard.prototype._press = function(k) {
    if (k === 'ok') {
      if (this.onConfirm) this.onConfirm(this.value);
      return;
    }
    if      (k === 'back') this._backspace();
    else if (k === '.')    this._typeDot();
    else                   this._typeDigit(k);
    this._render();
  };

  /* -- Navigation manette / clavier -- */
  NumericKeyboard.prototype.handleKey = function(key) {
    if (key === 'ArrowUp') {
      if (this.row === OK_ROW) { this.row = OK_ROW - 1; this.col = this._lastCol; }
      else if (this.row > 0)   { this.row--; }
    } else if (key === 'ArrowDown') {
      if (this.row === OK_ROW - 1) { this._lastCol = this.col; this.row = OK_ROW; this.col = 0; }
      else if (this.row < OK_ROW - 1) { this.row++; }
    } else if (key === 'ArrowLeft') {
      if (this.row !== OK_ROW) this.col = (this.col - 1 + COLS) % COLS;
    } else if (key === 'ArrowRight') {
      if (this.row !== OK_ROW) this.col = (this.col + 1) % COLS;
    } else if (key === 'Enter') {
      this._press(this._currentKey());
      return true;
    } else if (key === 'Triangle') {
      this._press('back');
      return true;
    } else if (key === 'Escape') {
      if (this.onCancel) this.onCancel();
      return true;
    } else {
      return false;
    }
    this._render();
    return true;
  };

  /* -- Rendu -- */
  NumericKeyboard.prototype._render = function() {
    var self = this;

    if (this.container) {
      this.container.innerHTML = '';
      this.container.style.cssText = 'width:clamp(220px,26vw,340px);margin:0 auto';

      LAYOUT.forEach(function(keys, ri) {
        var rowEl = document.createElement('div');
        rowEl.className = 'kb-row';
        rowEl.style.gridTemplateColumns = 'repeat(3, 1fr)';
        keys.forEach(function(k, ci) {
          var btn = document.createElement('div');
          btn.className = 'kb-key' + (self.row === ri && self.col === ci ? ' kbactive' : '');
          btn.style.cssText = KEY_STYLE;
          btn.textContent = (k === 'back') ? '\u232b' : k;
          btn.addEventListener('click', function() {
            self.row = ri; self.col = ci; self._press(k);
          });
          rowEl.appendChild(btn);
        });
        self.container.appendChild(rowEl);
      });

      var okRow = document.createElement('div');
      okRow.className = 'kb-row';
      okRow.style.gridTemplateColumns = '1fr';
      var ok = document.createElement('div');
      ok.className = 'kb-key confirm' + (this.row === OK_ROW ? ' kbactive' : '');
      ok.style.cssText = KEY_STYLE;
      ok.textContent = 'ENTR\u00c9E';
      ok.addEventListener('click', function() { self.row = OK_ROW; self.col = 0; self._press('ok'); });
      okRow.appendChild(ok);
      this.container.appendChild(okRow);
    }

    if (this.display) {
      this.display.textContent = this.fresh ? this.value : this.value + '|';
      this.display.style.background = this.fresh ? 'rgba(0,164,220,0.30)' : '';
    }
  };

  root._XeNumpad = { NumericKeyboard: NumericKeyboard };

})(typeof window !== 'undefined' ? window : this);
