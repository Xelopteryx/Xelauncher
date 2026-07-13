/**
 * input-mapper.js
 * InputMapper — persistance et résolution des mappages device→touches.
 *
 * CLÉ DE STOCKAGE : nom de l'appareil (ex: "Xbox Wireless Controller"),
 * PAS le chemin /dev/input/eventXX qui change selon les appareils branchés.
 *
 * xe_input.py v2 envoie { device: '/dev/input/event4', name: 'Xbox…', action, raw }
 * EvdevPoller utilise name comme clé stable.
 */

;(function(root) {
  'use strict';

  var STORAGE_KEY = 'xelauncher_inputmaps';

  function InputMapper(storageKey) {
    this.storageKey = storageKey || STORAGE_KEY;
    this._maps = this._load();
  }

  InputMapper.prototype._load = function() {
    try { return JSON.parse(localStorage.getItem(this.storageKey) || '{}'); } catch(e) { return {}; }
  };

  InputMapper.prototype._persist = function() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this._maps)); } catch(e) {}
  };

  /**
   * Sauvegarder le mapping pour un appareil.
   * @param {string} deviceId  — nom de l'appareil
   * @param {Object} map       — { actionId: rawPhysique, ... }
   */
  InputMapper.prototype.save = function(deviceId, map) {
    if (!deviceId) return;
    this._maps[deviceId] = map;
    this._persist();
  };

  InputMapper.prototype.get  = function(d) { return this._maps[d] || null; };
  InputMapper.prototype.has  = function(d) { return !!this._maps[d]; };

  /**
   * Renommer un appareil (garde son mapping).
   */
  InputMapper.prototype.rename = function(oldKey, newName) {
    if (!oldKey || !newName || oldKey === newName) return;
    var map = this._maps[oldKey];
    if (!map) return;
    this._maps[newName] = map;
    delete this._maps[oldKey];
    this._persist();
  };

  /**
   * Supprimer la config d'un appareil.
   */
  InputMapper.prototype.remove = function(deviceId) {
    if (!deviceId) return;
    delete this._maps[deviceId];
    this._persist();
  };

  InputMapper.prototype.clearAll = function() {
    this._maps = {};
    try { localStorage.removeItem(this.storageKey); } catch(e) {}
  };

  InputMapper.prototype.getDefault = function() {
    var m = {};
    root._XeUtils.ACTION_KEYS.forEach(function(a) { m[a.id] = a.default; });
    return m;
  };

  /**
   * Retourner toutes les clés (noms d'appareils configurés).
   */
  InputMapper.prototype.getAllKeys = function() {
    return Object.keys(this._maps);
  };

  /**
   * Résoudre une action ou raw brut vers une touche logique.
   *
   * Le map stocké est { actionId: rawPhysique }, ex:
   *   { up: 'KEY_103', confirm: 'KEY_304', back: 'KEY_305' }
   *
   * On cherche si rawKey correspond au rawPhysique d'un actionId,
   * et on retourne la touche logique associée (ArrowUp, Enter...).
   *
   * @param {string} deviceId  — nom de l'appareil
   * @param {string} rawKey    — action ou raw venant de xe_input
   */
  InputMapper.prototype.resolveKey = function(deviceId, rawKey) {
    if (deviceId === '__keyboard__') return rawKey;
    var map = this._maps[deviceId];
    if (!map) return rawKey;
    var ACTION_KEYS = root._XeUtils.ACTION_KEYS;
    /* Chercher si rawKey est le raw assigné à un actionId */
    for (var actionId in map) {
      if (map[actionId] === rawKey) {
        var a = ACTION_KEYS.find(function(k) { return k.id === actionId; });
        return a ? a.default : rawKey;
      }
    }
    /* rawKey est peut-être déjà une action ('up', 'confirm'...) */
    var def = ACTION_KEYS.find(function(k) { return k.id === rawKey; });
    return def ? def.default : rawKey;
  };

  root._XeInputMapper = { InputMapper };

})(typeof window !== 'undefined' ? window : this);
