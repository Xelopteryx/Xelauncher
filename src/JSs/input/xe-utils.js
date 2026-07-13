/**
 * xe-utils.js
 * Constantes, utilitaires partagés, Toast, wakeLock, préférences layout.
 * Exposé sur window.XeInput après chargement.
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

  var GP_DEFAULT = {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    confirm: 'Enter', back: 'Escape', menu: 'Start', action: 'Triangle',
  };

  /* ── Accents ── */
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
  };

  /* ── prettyRaw ── */
  function prettyRaw(raw) {
    if (!raw) return '';
    var labels = {
      'up':'↑','down':'↓','left':'←','right':'→',
      'confirm':'Confirmer','back':'Retour','menu':'Menu','select':'Select',
      'action':'Action','l1':'L1','r1':'R1','l2':'L2','r2':'R2','l3':'L3','r3':'R3',
    };
    return labels[raw] || raw;
  }

  /* ── Préférence layout clavier ── */
  function getLayoutPref() {
    try { return localStorage.getItem('xelauncher_kb_layout') || 'azerty'; } catch(e) { return 'azerty'; }
  }
  function setLayoutPref(v) {
    try { localStorage.setItem('xelauncher_kb_layout', v); } catch(e) {}
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

  /* ── Export partiel (sera complété par input.js barrel) ── */
  root._XeUtils = {
    ACTION_TO_KEY, ACTION_KEYS, GP_DEFAULT, ACCENTS,
    prettyRaw, getLayoutPref, setLayoutPref, requestWakeLock, Toast,
  };

})(typeof window !== 'undefined' ? window : this);
