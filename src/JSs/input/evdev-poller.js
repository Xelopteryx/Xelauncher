/**
 * evdev-poller.js
 * EvdevPoller — écoute les events IPC de xe_input.py (v3) et les résout en
 * touches logiques XeLauncher.
 *
 * Protocole xe_input.py v3 :
 *   { device, name, kind, action, raw, state }   state: 'down' (canal
 *   'xe-input-event') ou 'up' (canal 'xe-input-release').
 *
 * Résolution STRICTE :
 *   - appareil avec un mappage personnalisé -> seules les touches mappées
 *     fonctionnent, tout le reste est ignoré (clavier compris) ;
 *   - appareil sans mappage (ou "valeurs par défaut") -> table intégrée.
 *
 * Répétition sur appui maintenu (directions uniquement) : gérée ici, donc
 * valable pour toutes les pages ET pour les touches mappées librement.
 *
 * Mode rawCapture : bypass de tout, envoie le raw à onRawEvent(raw, name, data).
 */

;(function(root) {
  'use strict';

  var ACCEPTED_ACTIONS = {
    'up':true,'down':true,'left':true,'right':true,
    'confirm':true,'back':true,'menu':true,'select':true,
    'action':true,'l1':true,'r1':true,'l2':true,'r2':true,'l3':true,'r3':true,
  };

  var REPEAT_KEYS     = { ArrowUp:1, ArrowDown:1, ArrowLeft:1, ArrowRight:1 };
  var REPEAT_DELAY    = 500;    /* ms avant le début de la répétition */
  var REPEAT_INTERVAL = 90;     /* ms entre deux répétitions */
  var REPEAT_MAX      = 8000;   /* garde-fou : entrée coincée */

  function EvdevPoller(onKey) {
    this.onKey        = onKey;
    this._customMaps  = null;   // ref vers InputMapper._maps
    this.onRawEvent   = null;   // (raw, deviceName, data) avant résolution
    this.debugMode    = false;
    this.onDebug      = null;
    this.rawCapture   = false;
    this._bound       = null;
    this._boundUp     = null;
    this._running     = false;
    this._repeats     = {};
    this._lastGpId    = '__keyboard__';
    this._lastGpName  = '__keyboard__';
  }

  EvdevPoller.prototype.start = function() {
    if (this._running) return;
    if (!window.xeLauncher || !window.xeLauncher.onXeInputEvent) {
      console.warn('EvdevPoller: onXeInputEvent non disponible');
      return;
    }
    if (window.xeLauncher.offXeInputEvent)   window.xeLauncher.offXeInputEvent();
    if (window.xeLauncher.offXeInputRelease) window.xeLauncher.offXeInputRelease();
    this._running = true;
    var self = this;
    this._bound = function(data) { self._onEvent(data); };
    window.xeLauncher.onXeInputEvent(this._bound);
    if (window.xeLauncher.onXeInputRelease) {
      this._boundUp = function(data) { self._onRelease(data); };
      window.xeLauncher.onXeInputRelease(this._boundUp);
    }
  };

  EvdevPoller.prototype.stop = function() {
    if (!this._running) return;
    this._running = false;
    this._stopAllRepeats();
    if (window.xeLauncher) {
      if (window.xeLauncher.offXeInputEvent)   window.xeLauncher.offXeInputEvent();
      if (window.xeLauncher.offXeInputRelease) window.xeLauncher.offXeInputRelease();
    }
  };

  /** Nom stable de l'appareil (data.name) plutôt que le chemin (data.device). */
  EvdevPoller.prototype._deviceName = function(data) {
    if (data.name && data.name !== data.device) return data.name;
    return data.device || '__unknown__';
  };

  /**
   * Résout la touche logique d'un event.
   * Mappage personnalisé : on cherche le RAW physique reçu parmi les boutons
   * enregistrés pour chaque action ; aucune correspondance = null (touche ignorée).
   */
  EvdevPoller.prototype._resolve = function(action, raw, deviceName) {
    var U  = root._XeUtils;
    var cm = this._customMaps && this._customMaps[deviceName];
    if (cm && !cm.__default) {
      var custom = false;
      for (var aid in cm) {
        if (aid.charAt(0) === '_' || !cm[aid]) continue;
        var raws = [].concat(cm[aid]);          /* une action = un ou plusieurs boutons */
        if (!raws.length) continue;
        custom = true;
        if (raws.indexOf(raw) >= 0) {
          var a = U.ALL_ACTION_KEYS.find(function(k) { return k.id === aid; });
          return a ? a.default : null;
        }
      }
      if (custom) return null;
    }
    if (!action || !ACCEPTED_ACTIONS[action]) return null;
    return U.ACTION_TO_KEY[action] || null;
  };

  /* ── Répétition ── */
  EvdevPoller.prototype._startRepeat = function(id, key) {
    this._stopRepeat(id);
    var self = this, rep = { key: key, interval: null, t0: 0 };
    rep.delay = setTimeout(function() {
      rep.t0 = Date.now();
      rep.interval = setInterval(function() {
        if (Date.now() - rep.t0 > REPEAT_MAX) { self._stopRepeat(id); return; }
        self.onKey(key);
      }, REPEAT_INTERVAL);
    }, REPEAT_DELAY);
    this._repeats[id] = rep;
  };

  EvdevPoller.prototype._stopRepeat = function(id) {
    var rep = this._repeats[id];
    if (!rep) return;
    clearTimeout(rep.delay);
    if (rep.interval) clearInterval(rep.interval);
    delete this._repeats[id];
  };

  EvdevPoller.prototype._stopAllRepeats = function() {
    for (var id in this._repeats) this._stopRepeat(id);
  };

  EvdevPoller.prototype._onRelease = function(data) {
    if (!data || !data.device) return;
    this._stopRepeat(this._deviceName(data) + '|' + (data.raw || ''));
  };

  EvdevPoller.prototype._onEvent = function(data) {
    if (!data || !data.device) return;
    var action     = data.action || null;
    var raw        = data.raw || action;
    var deviceName = this._deviceName(data);

    this._lastGpId   = deviceName;
    this._lastGpName = deviceName;

    /* Mode rawCapture : envoie le raw brut, sans rien résoudre */
    if (this.rawCapture) {
      if (this.onRawEvent && raw) this.onRawEvent(raw, deviceName, data);
      return;
    }

    if (this.debugMode && this.onDebug) this.onDebug({ raw: raw, gpId: deviceName });

    /* Callback brut (mapper inline, jf-mapping, test des touches...) */
    if (this.onRawEvent && raw) this.onRawEvent(raw, deviceName, data);

    var key = this._resolve(action, raw, deviceName);
    if (!key) return;
    this.onKey(key);
    if (REPEAT_KEYS[key]) this._startRepeat(deviceName + '|' + raw, key);
  };

  root._XeEvdevPoller = { EvdevPoller };

})(typeof window !== 'undefined' ? window : this);
