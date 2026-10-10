/**
 * input-mapper.js
 * InputMapper — persistance et résolution des mappages device→touches.
 *
 * CLÉ DE STOCKAGE : nom evdev de l'appareil (ex: "Xbox Wireless Controller"),
 * PAS le chemin /dev/input/eventXX. Cette clé ne change JAMAIS (renommer un
 * appareil ne touche qu'à ses métadonnées : alias).
 *
 * Format d'un mappage : { actionId: [raw, raw, ...] }
 *   ex { up:['KEY_103','ABS_1_neg','ABS_17_neg'], confirm:['KEY_304'], ... }
 *   - UNE action peut avoir PLUSIEURS boutons (croix + joystick + touche...)
 *   - UN bouton ne peut servir qu'à UNE seule action
 *   - les 8 actions doivent avoir au moins un bouton
 *   - { __default: 1 } = "valeurs par défaut" (table intégrée de xe_input.py)
 *   - un mappage personnalisé est STRICT : un bouton non mappé ne fait rien
 *   (ancien format { actionId: 'raw' } converti automatiquement)
 *
 * Métadonnées (clé séparée '<storageKey>_meta') : { alias, kind, addedAt, updatedAt }
 */

;(function(root) {
  'use strict';

  var STORAGE_KEY = 'xelauncher_inputmaps';
  var RAW_RE      = /^(KEY|ABS|REL)_\d+/;
  var NAV_IDS     = ['up', 'down', 'left', 'right', 'confirm', 'back'];

  function toList(v) { return [].concat(v == null ? [] : v).filter(function(x) { return typeof x === 'string' && x; }); }

  function realKeys(map) {
    return Object.keys(map || {}).filter(function(k) { return k.charAt(0) !== '_' && toList(map[k]).length; });
  }

  /** Copie normalisée : { actionId: [raw...] } (+ __default conservé), sans doublon de raw. */
  function normalize(map) {
    var U = root._XeUtils, out = {}, used = {};
    if (map && map.__default) out.__default = 1;
    U.ALL_ACTION_KEYS.forEach(function(a) {
      var list = toList(map && map[a.id]).filter(function(r) { if (used[r]) return false; used[r] = 1; return true; });
      if (list.length) out[a.id] = list;
    });
    return out;
  }

  function InputMapper(storageKey) {
    this.storageKey = storageKey || STORAGE_KEY;
    this.metaKey    = this.storageKey + '_meta';
    this._maps      = this._load(this.storageKey);   /* identité conservée : partagée avec EvdevPoller */
    this._meta      = this._load(this.metaKey);
    this._migrate();
  }

  InputMapper.prototype._load = function(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch(e) { return {}; }
  };

  InputMapper.prototype._persist = function() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this._maps)); } catch(e) {}
    try { localStorage.setItem(this.metaKey,    JSON.stringify(this._meta)); } catch(e) {}
    this.exportToDisk();
  };

  /** Copie sur disque (inputmaps.json) : le relais vers Turtlefin la lit une fois Electron fermé. */
  InputMapper.prototype.exportToDisk = function() {
    if (this.storageKey !== STORAGE_KEY) return;
    try {
      if (root.xeLauncher && root.xeLauncher.saveInputMaps) root.xeLauncher.saveInputMaps(this._maps);
    } catch(e) {}
  };

  /**
   * - ancien format (une chaîne par action) -> tableau ;
   * - anciens noms DOM ('k', 'ArrowUp'...) -> raws evdev ; si une action de
   *   navigation est perdue, l'appareil repasse en valeurs par défaut plutôt
   *   que de devenir muet.
   */
  InputMapper.prototype._migrate = function() {
    var U = root._XeUtils, self = this, changed = false;
    Object.keys(this._maps).forEach(function(dev) {
      var map = self._maps[dev];
      if (!map || typeof map !== 'object') { delete self._maps[dev]; changed = true; return; }
      var before = JSON.stringify(map);
      var legacy = false, conv = {};
      Object.keys(map).forEach(function(k) {
        if (k.charAt(0) === '_') { conv[k] = map[k]; return; }
        conv[k] = toList(map[k]).map(function(v) {
          if (RAW_RE.test(v)) return v;
          legacy = true;
          return U.legacyToRaw(v);
        }).filter(Boolean);
      });
      var out = normalize(conv);
      if (legacy && !NAV_IDS.every(function(id) { return out[id] && out[id].length; })) out = { __default: 1 };
      if (JSON.stringify(out) !== before) { self._maps[dev] = out; changed = true; }
    });
    if (changed) this._persist();
  };

  /**
   * @param {string} deviceId  nom de l'appareil
   * @param {Object} map       { actionId: [raw...] } ou { __default: 1 }
   * @param {Object} [meta]    { kind }
   */
  InputMapper.prototype.save = function(deviceId, map, meta) {
    if (!deviceId) return;
    this._maps[deviceId] = normalize(map);
    var m = this._meta[deviceId] || {}, now = Date.now();
    if (!m.addedAt) m.addedAt = now;
    m.updatedAt = now;
    if (meta && meta.kind) m.kind = meta.kind;
    this._meta[deviceId] = m;
    this._persist();
  };

  InputMapper.prototype.get  = function(d) { return this._maps[d] || null; };
  InputMapper.prototype.has  = function(d) { return !!this._maps[d]; };

  InputMapper.prototype.isDefault = function(d) {
    var m = this._maps[d];
    return !!m && (!!m.__default || !realKeys(m).length);
  };

  InputMapper.prototype.getMeta = function(d) {
    var m = this._meta[d]; return m ? Object.assign({}, m) : {};
  };

  InputMapper.prototype.setMeta = function(d, patch) {
    if (!d) return;
    this._meta[d] = Object.assign(this._meta[d] || {}, patch || {});
    this._persist();
  };

  /** Nom personnalisé (n'affecte PAS la clé de stockage). Vide = retirer. */
  InputMapper.prototype.setAlias = function(d, name) {
    if (!d) return;
    name = (name || '').trim();
    var m = this._meta[d] || {};
    if (name) m.alias = name; else delete m.alias;
    this._meta[d] = m;
    this._persist();
  };

  /** Compatibilité : "renommer" ne déplace plus la clé, il pose un alias. */
  InputMapper.prototype.rename = function(oldKey, newName) { this.setAlias(oldKey, newName); };

  InputMapper.prototype.remove = function(deviceId) {
    if (!deviceId) return;
    delete this._maps[deviceId];
    delete this._meta[deviceId];
    this._persist();
  };

  InputMapper.prototype.clearAll = function() {
    var self = this;
    Object.keys(this._maps).forEach(function(k) { delete self._maps[k]; });
    Object.keys(this._meta).forEach(function(k) { delete self._meta[k]; });
    try { localStorage.removeItem(this.storageKey); localStorage.removeItem(this.metaKey); } catch(e) {}
    this.exportToDisk();
  };

  /** Valeurs par défaut = table intégrée (pas de raws personnalisés). */
  InputMapper.prototype.getDefault = function() { return { __default: 1 }; };

  InputMapper.prototype.getAllKeys = function() { return Object.keys(this._maps); };

  /** Actions → boutons personnalisés : { actionId: [raw...] } (sans clés internes). */
  InputMapper.prototype.getAssignments = function(d) {
    var m = this._maps[d], out = {};
    realKeys(m).forEach(function(k) { out[k] = toList(m[k]); });
    return out;
  };

  /** Quelle action utilise déjà ce raw ? (exceptId : action à ignorer) */
  InputMapper.prototype.ownerOf = function(map, raw, exceptId) {
    for (var id in map) {
      if (id.charAt(0) === '_' || id === exceptId) continue;
      if (toList(map[id]).indexOf(raw) >= 0) return id;
    }
    return null;
  };

  /** Raws utilisés par plus d'une action : [{raw, actions:[...]}] */
  InputMapper.prototype.findConflicts = function(map) {
    var by = {}, out = [];
    Object.keys(map || {}).forEach(function(id) {
      if (id.charAt(0) === '_') return;
      toList(map[id]).forEach(function(r) { (by[r] = by[r] || []).push(id); });
    });
    Object.keys(by).forEach(function(raw) { if (by[raw].length > 1) out.push({ raw: raw, actions: by[raw] }); });
    return out;
  };

  /**
   * Résout un raw brut vers une touche logique (ArrowUp, Enter...).
   *  - raw mappé               -> touche de l'action
   *  - raw NON mappé, appareil personnalisé -> null (ignoré)
   *  - déjà une touche logique / une action -> renvoyée telle quelle
   */
  InputMapper.prototype.resolveKey = function(deviceId, rawKey) {
    if (deviceId === '__keyboard__') return rawKey;
    var map = this._maps[deviceId];
    if (!map) return rawKey;
    var ALL = root._XeUtils.ALL_ACTION_KEYS;
    for (var actionId in map) {
      if (actionId.charAt(0) === '_') continue;
      if (toList(map[actionId]).indexOf(rawKey) >= 0) {
        var a = ALL.find(function(k) { return k.id === actionId; });
        return a ? a.default : rawKey;
      }
    }
    if (RAW_RE.test(rawKey) && realKeys(map).length) return null;
    var def = ALL.find(function(k) { return k.id === rawKey; });
    return def ? def.default : rawKey;
  };

  root._XeInputMapper = { InputMapper };

})(typeof window !== 'undefined' ? window : this);
