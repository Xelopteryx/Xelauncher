/**
 * input.js — Point d'entrée unique du système input XeLauncher.
 *
 * Ce fichier est le SEUL chargé par les pages HTML (inchangé).
 * Il charge les 5 modules depuis JSs/input/ puis assemble window.XeInput.
 *
 * Structure attendue :
 *   JSs/
 *     input.js            ← ce fichier
 *     input/
 *       xe-utils.js       → window._XeUtils
 *       input-mapper.js   → window._XeInputMapper
 *       evdev-poller.js   → window._XeEvdevPoller
 *       remote-capture.js → window._XeRemoteCapture
 *       keyboard.js       → window._XeKeyboard
 */

;(function() {
  'use strict';

  /* ── Résolution du BASE path depuis l'URL de ce script ── */
  var BASE = (function() {
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || '';
      if (src.indexOf('input.js') !== -1) {
        return src.replace(/input\.js.*$/, '');
      }
    }
    return '';
  })();

  /* ── Chargement séquentiel garanti via onload ──
     Les scripts ajoutés dynamiquement avec async=false ne sont PAS
     garantis synchrones dans les navigateurs modernes (Electron inclus).
     On enchaîne les onload pour s'assurer que chaque module est exécuté
     avant de charger le suivant, puis on assemble XeInput. */
  var MODULES = [
    'input/xe-utils.js',
    'input/input-mapper.js',
    'input/evdev-poller.js',
    'input/remote-capture.js',
    'input/keyboard.js',
  ];

  function loadSequential(list, done) {
    if (!list.length) { done(); return; }
    var el = document.createElement('script');
    el.src = BASE + list[0];
    el.type = 'text/javascript';
    el.onload  = function() { loadSequential(list.slice(1), done); };
    el.onerror = function() {
      console.error('[XeInput] Failed to load: ' + el.src);
      loadSequential(list.slice(1), done);
    };
    document.head.appendChild(el);
  }

  loadSequential(MODULES, function() {
    _assembleXeInput();
  });

  function _assembleXeInput() {
    if (window.XeInput) return; // déjà assemblé

    var utils   = window._XeUtils          || {};
    var mapper  = window._XeInputMapper    || {};
    var poller  = window._XeEvdevPoller    || {};
    var remote  = window._XeRemoteCapture  || {};
    var kb      = window._XeKeyboard       || {};

    window.XeInput = {
      VirtualKeyboard: kb.VirtualKeyboard,
      InputMapper:     mapper.InputMapper,
      EvdevPoller:     poller.EvdevPoller,
      RemoteCapture:   remote.RemoteCapture,
      ACTION_KEYS:     utils.ACTION_KEYS,
      ACTION_TO_KEY:   utils.ACTION_TO_KEY,
      GP_DEFAULT:      utils.GP_DEFAULT,
      ACCENTS:         utils.ACCENTS,
      prettyRaw:       utils.prettyRaw,
      getLayoutPref:   utils.getLayoutPref,
      setLayoutPref:   utils.setLayoutPref,
      requestWakeLock: utils.requestWakeLock,
      Toast:           utils.Toast,
    };
  }

})();
