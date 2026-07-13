/**
 * evdev-poller.js
 * EvdevPoller — écoute les events IPC de xe_input.py,
 * résout les actions en touches logiques XeLauncher.
 *
 * Protocole xe_input.py v2 :
 *   { device: '/dev/input/event4', name: 'Xbox Wireless Controller',
 *     action: 'confirm', raw: 'KEY_304' }
 *
 * L'identifiant utilisé pour le mapping est le NAME (nom lisible),
 * stable quelque soit le numéro d'event.
 * Si name est absent (ancienne version), on utilise device comme fallback.
 *
 * Mode rawCapture (rawCapture=true) :
 *   Bypass ACCEPTED_ACTIONS, envoie tout à onRawEvent(raw, name).
 *   Utilisé par mapper.js pour capturer toutes les touches.
 */

;(function(root) {
  'use strict';

  var ACCEPTED_ACTIONS = {
    'up':true,'down':true,'left':true,'right':true,
    'confirm':true,'back':true,'menu':true,'select':true,
    'action':true,'l1':true,'r1':true,'l2':true,'r2':true,'l3':true,'r3':true,
  };

  function EvdevPoller(onKey) {
    this.onKey        = onKey;
    this._customMaps  = null;   // ref vers InputMapper._maps
    this.onRawEvent   = null;   // (raw, deviceName) avant résolution
    this.debugMode    = false;
    this.onDebug      = null;   // ({ raw, gpId })
    this.rawCapture   = false;  // si true : bypass filtre, envoie tout
    this._bound       = null;
    this._running     = false;
    this._lastGpId    = '__keyboard__';
    this._lastGpName  = '__keyboard__';
  }

  EvdevPoller.prototype.start = function() {
    if (this._running) return;
    if (!window.xeLauncher || !window.xeLauncher.onXeInputEvent) {
      console.warn('EvdevPoller: onXeInputEvent non disponible');
      return;
    }
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

  /**
   * Retourner le nom stable de l'appareil.
   * Priorité : data.name (lisible, stable) > data.device (chemin, change)
   */
  EvdevPoller.prototype._deviceName = function(data) {
    if (data.name && data.name !== data.device) return data.name;
    return data.device || '__unknown__';
  };

  EvdevPoller.prototype._resolve = function(action, deviceName) {
    var ACTION_TO_KEY = root._XeUtils.ACTION_TO_KEY;
    var ACTION_KEYS   = root._XeUtils.ACTION_KEYS;
    var cm = this._customMaps && this._customMaps[deviceName];
    if (cm) {
      /* Le map contient { actionId: rawPhysique }, ex: { up: 'KEY_103' }
         On cherche si 'action' correspond au rawPhysique stocké */
      for (var aid in cm) {
        if (cm[aid] === action) {
          var a = ACTION_KEYS.find(function(k) { return k.id === aid; });
          return a ? a.default : null;
        }
      }
      /* Action connue mais pas dans le custom map → utiliser table par défaut */
      return ACTION_TO_KEY[action] || null;
    }
    return ACTION_TO_KEY[action] || null;
  };

  EvdevPoller.prototype._onEvent = function(data) {
    if (!data || !data.device) return;
    var action     = data.action;
    var raw        = data.raw || action;
    var deviceName = this._deviceName(data);

    /* Mémoriser l'identité */
    this._lastGpId   = deviceName;
    this._lastGpName = deviceName;

    /* ── Mode rawCapture : bypass tout, envoie le raw brut ── */
    if (this.rawCapture) {
      if (this.onRawEvent && raw) this.onRawEvent(raw, deviceName);
      return;
    }

    if (!action) return;

    /* Debug */
    if (this.debugMode && this.onDebug)
      this.onDebug({ raw: raw, gpId: deviceName });

    /* Callback brut (pour mapper inline, jf-mapping...) */
    if (this.onRawEvent) this.onRawEvent(raw, deviceName);

    /* Filtrer les actions non reconnues */
    if (!ACCEPTED_ACTIONS[action]) return;

    var key = this._resolve(action, deviceName);
    if (key) this.onKey(key);
  };

  root._XeEvdevPoller = { EvdevPoller };

})(typeof window !== 'undefined' ? window : this);
