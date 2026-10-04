/**
 * settings-controllers.js
 * Onglet Manettes : liste des appareils configurés (icône manette.png), et au
 * clic un panneau d'actions :
 *   ℹ Informations  — nom, nom système, type, date d'ajout, touches mappées
 *   ✏ Renommer      — pour un appareil Bluetooth : renomme AUSSI l'appareil
 *                     Bluetooth (même nom partout) ; sinon alias local
 *   ↺ Reconfigurer  — rouvre le mapper (récapitulatif)
 *   🎯 Tester        — affiche en direct touche physique → action
 *   ✕ Supprimer     — avec confirmation
 *
 * Nom affiché : nom Bluetooth (celui donné à l'appairage / renommage) >
 * alias local > nom système evdev. La clé de stockage du mappage reste
 * toujours le nom evdev.
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.Controllers = (() => {

  /* ─────────────────────────────────────────────────────────────
     ACCÈS MAPPER / BLUETOOTH
  ───────────────────────────────────────────────────────────── */
  let _mapper = null;
  function _setMapper(m) { _mapper = m; }
  function _getMapper() { return _mapper || (typeof mapper !== 'undefined' ? mapper : null); }

  const KIND_LABEL    = { keyboard: 'Clavier', gamepad: 'Manette', remote: 'Télécommande' };
  const BT_TYPE_LABEL = { controller: 'Manette', wiimote: 'Wiimote', keyboard: 'Clavier / souris', audio: 'Audio', other: 'Appareil Bluetooth' };

  /* Copie locale des appareils Bluetooth appairés (noms personnalisés inclus) */
  let _bt = [];
  function _refreshBt() {
    if (!window.xeLauncher || !window.xeLauncher.btListPaired) return Promise.resolve();
    return window.xeLauncher.btListPaired().then(d => { _bt = d || []; }).catch(() => {});
  }
  function _btFor(key) {
    const k = String(key || '').toLowerCase();
    return _bt.find(d => (d.origName && d.origName.toLowerCase() === k) || (d.name && d.name.toLowerCase() === k)) || null;
  }

  function _displayName(key) {
    if (key === REMOTE_DEVICE_ID) return 'Télécommande';
    const bt = _btFor(key);
    if (bt && bt.name) return bt.name;
    const m = _getMapper();
    const meta = m ? m.getMeta(key) : {};
    return meta.alias || key;
  }

  function _typeLabel(key) {
    const m    = _getMapper();
    const meta = m ? m.getMeta(key) : {};
    if (meta.kind && KIND_LABEL[meta.kind]) return KIND_LABEL[meta.kind];
    const bt = _btFor(key);
    if (bt && BT_TYPE_LABEL[bt.type]) return BT_TYPE_LABEL[bt.type];
    if (/keyboard|clavier/i.test(key))                                  return 'Clavier';
    if (/wii|rvl|remote|t[ée]l[ée]commande/i.test(key))                 return 'Télécommande';
    if (/controller|gamepad|joy|xbox|dual|pad|8bitdo|stick/i.test(key)) return 'Manette';
    return 'Périphérique';
  }

  function _assignments(key) { const m = _getMapper(); return m ? m.getAssignments(key) : {}; }
  function _isDefault(key)   { const m = _getMapper(); return !m || m.isDefault(key); }
  function _allActions()     { return XeInput.ALL_ACTION_KEYS || XeInput.ACTION_KEYS; }
  /* Une action peut avoir plusieurs boutons : on les affiche séparés par « · » */
  function _rawsText(v) { return [].concat(v || []).map(r => XeInput.prettyRaw(r) || r).join('  ·  '); }
  function _bindCount(key) {
    const m = _assignments(key);
    return Object.keys(m).reduce((n, id) => n + [].concat(m[id]).length, 0);
  }

  function _fmtDate(ts) {
    if (!ts) return 'Inconnue';
    try {
      return new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return 'Inconnue'; }
  }

  function _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function _icon() {
    const wrap = _el('span', 'ctl-icon');
    const img  = document.createElement('img');
    img.src = '../LOGOs/manette.png'; img.alt = ''; img.draggable = false;
    img.onerror = () => { img.remove(); wrap.textContent = '🎮'; };
    wrap.appendChild(img);
    return wrap;
  }

  /* ─────────────────────────────────────────────────────────────
     LISTE DES APPAREILS
  ───────────────────────────────────────────────────────────── */
  function _namesSig() { return (_getMapper()?.getAllKeys() || []).map(_displayName).join('|'); }

  function renderDeviceMaps(noRefresh) {
    const c = document.getElementById('deviceMapList');
    if (!c) return;
    c.innerHTML = '';

    const keys = _getMapper()?.getAllKeys() || [];
    if (!keys.length) {
      c.appendChild(_el('div', 'ctl-empty', 'Aucun appareil configuré'));
      updateContentFocus();
      return;
    }

    keys.forEach(deviceKey => {
      const el = _el('div', 'device-item');
      el.dataset.deviceKey = deviceKey;
      el.appendChild(_icon());

      const mid = _el('div', 'ctl-mid');
      mid.appendChild(_el('div', 'device-name', _displayName(deviceKey)));
      const n = _bindCount(deviceKey);
      mid.appendChild(_el('div', 'ctl-sub',
        _typeLabel(deviceKey) + (_isDefault(deviceKey) ? '' : '  ·  ' + n + ' touche' + (n > 1 ? 's' : ''))));
      el.appendChild(mid);

      el.appendChild(_el('span', 'ctl-badge', _isDefault(deviceKey) ? 'par défaut' : 'configuré'));
      el.addEventListener('click', () => openDeviceAction(deviceKey));
      c.appendChild(el);
    });
    updateContentFocus();

    /* Les noms Bluetooth arrivent de façon asynchrone : on redessine si un nom a changé. */
    if (!noRefresh) {
      const before = _namesSig();
      _refreshBt().then(() => { if (_namesSig() !== before && typeof activeTab !== 'undefined' && activeTab === 'controllers') renderDeviceMaps(true); });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     PANNEAU D'ACTIONS
  ───────────────────────────────────────────────────────────── */
  let _key   = null;
  let _view  = 'menu';          // 'menu' | 'info' | 'confirm' | 'test'
  let _focus = 0;
  let _items = [];

  /* Test des touches */
  let _testPrev = null, _testLast = null, _testBackAt = 0;

  function openDeviceAction(deviceKey) {
    _key = deviceKey; _view = 'menu'; _focus = 0;
    document.getElementById('deviceActionOverlay').classList.add('visible');
    screen = 'deviceAction';
    _render();
  }

  function _close() {
    _stopTest();
    document.getElementById('deviceActionOverlay').classList.remove('visible');
    screen = 'main';
    renderDeviceMaps(true);
  }

  function _btn(label, cls, focused, onClick) {
    const b = _el('div', 'bt-action-btn' + (cls ? ' ' + cls : '') + (focused ? ' focused' : ''), label);
    b.addEventListener('click', onClick);
    return b;
  }

  function _row(label, value) {
    const r = _el('div', 'ctl-info-row');
    r.appendChild(_el('span', 'ctl-info-label', label));
    r.appendChild(_el('span', 'ctl-info-value', value));
    return r;
  }

  function _render() {
    const name  = _displayName(_key);
    document.getElementById('deviceActionTitle').textContent = name;
    document.getElementById('deviceActionSub').textContent   = name !== _key ? _key : _typeLabel(_key);
    const list = document.getElementById('deviceActionList');
    list.innerHTML = '';

    if (_view === 'menu')         _renderMenu(list);
    else if (_view === 'info')    _renderInfo(list);
    else if (_view === 'confirm') _renderConfirm(list);
    else if (_view === 'test')    _renderTest(list);
  }

  /* ── Menu ── */
  function _renderMenu(list) {
    _items = [
      { label: 'ℹ  Informations',          id: 'info'     },
      { label: '✏  Renommer',               id: 'rename'   },
      { label: '↺  Reconfigurer',           id: 'reconfig' },
      { label: '🎯  Tester les touches',    id: 'test'     },
      { label: '✕  Supprimer',              id: 'delete', danger: true },
    ];
    _items.forEach((it, i) => list.appendChild(
      _btn(it.label, it.danger ? 'danger' : '', i === _focus, () => { _focus = i; _exec(it.id); })));
  }

  /* ── Informations ── */
  function _renderInfo(list) {
    const m    = _getMapper();
    const meta = m ? m.getMeta(_key) : {};
    const bt   = _btFor(_key);
    const box  = _el('div', 'ctl-info');

    box.appendChild(_row('Nom', _displayName(_key)));
    box.appendChild(_row('Nom système', _key));
    box.appendChild(_row('Type', _typeLabel(_key)));
    if (bt) box.appendChild(_row('Bluetooth', bt.mac + (bt.connected ? '  ·  connecté' : '')));
    box.appendChild(_row('Ajouté le', _fmtDate(meta.addedAt)));
    if (meta.updatedAt && meta.updatedAt !== meta.addedAt) box.appendChild(_row('Modifié le', _fmtDate(meta.updatedAt)));

    box.appendChild(_el('div', 'ctl-info-title', 'Touches mappées'));
    if (_isDefault(_key)) {
      box.appendChild(_el('div', 'ctl-info-note', 'Valeurs par défaut de l\'appareil (aucune touche personnalisée)'));
    } else {
      const map  = _assignments(_key);
      const grid = _el('div', 'ctl-keys');
      _allActions().forEach(a => {
        if (!map[a.id]) return;
        const chip = _el('div', 'ctl-key');
        chip.appendChild(_el('span', 'ctl-key-act', a.label));
        chip.appendChild(_el('span', 'ctl-key-raw', _rawsText(map[a.id])));
        grid.appendChild(chip);
      });
      box.appendChild(grid);
    }
    list.appendChild(box);
    list.appendChild(_btn('← Retour', '', true, () => { _view = 'menu'; _render(); }));
  }

  /* ── Confirmation de suppression ── */
  function _renderConfirm(list) {
    list.appendChild(_el('div', 'ctl-info-note', 'Supprimer la configuration de « ' + _displayName(_key) + ' » ?'));
    _items = [{ id: 'cancel', label: 'Annuler' }, { id: 'do-delete', label: 'Supprimer', danger: true }];
    _items.forEach((it, i) => list.appendChild(
      _btn(it.label, it.danger ? 'danger' : '', i === _focus, () => { _focus = i; _exec(it.id); })));
  }

  /* ── Test des touches ── */
  function _startTest() {
    _view = 'test'; _testLast = null; _testBackAt = 0;
    const gp = (typeof gpPoller !== 'undefined') ? gpPoller : null;
    if (gp && !_testPrev) {
      _testPrev = gp.onRawEvent || (() => {});
      gp.onRawEvent = function(raw, name) {
        _testPrev.apply(this, arguments);
        if (name === _key) _onTestRaw(raw);
      };
    }
    _render();
  }

  function _stopTest() {
    const gp = (typeof gpPoller !== 'undefined') ? gpPoller : null;
    if (gp && _testPrev) { gp.onRawEvent = _testPrev; }
    _testPrev = null;
  }

  function _onTestRaw(raw) {
    if (screen !== 'deviceAction' || _view !== 'test') return;
    const map = _assignments(_key);
    let actionId = null;
    for (const id in map) if ([].concat(map[id]).indexOf(raw) >= 0) { actionId = id; break; }
    _testLast = { raw, actionId };
    _render();
  }

  function _renderTest(list) {
    const map = _assignments(_key);
    const box = _el('div', 'ctl-info');
    box.appendChild(_el('div', 'ctl-info-note', 'Appuyez sur les touches de l\'appareil — Retour ×2 pour quitter'));

    const live = _el('div', 'ctl-test-live');
    if (!_testLast) {
      live.textContent = '—';
    } else {
      const a = _testLast.actionId ? _allActions().find(x => x.id === _testLast.actionId) : null;
      live.textContent = (XeInput.prettyRaw(_testLast.raw) || _testLast.raw) + '  →  ' +
        (a ? a.label : (_isDefault(_key) ? 'valeur par défaut' : 'non mappé (ignoré)'));
      live.classList.toggle('miss', !a && !_isDefault(_key));
    }
    box.appendChild(live);

    if (!_isDefault(_key)) {
      const grid = _el('div', 'ctl-keys');
      _allActions().forEach(a => {
        if (!map[a.id]) return;
        const chip = _el('div', 'ctl-key' + (_testLast && _testLast.actionId === a.id ? ' hit' : ''));
        chip.appendChild(_el('span', 'ctl-key-act', a.label));
        chip.appendChild(_el('span', 'ctl-key-raw', _rawsText(map[a.id])));
        grid.appendChild(chip);
      });
      box.appendChild(grid);
    }
    list.appendChild(box);
    list.appendChild(_btn('← Quitter le test', '', true, () => { _stopTest(); _view = 'menu'; _render(); }));
  }

  /* ── Exécution des actions ── */
  function _exec(id) {
    const m = _getMapper();
    if (id === 'info')    { _view = 'info'; _render(); return; }
    if (id === 'test')    { _startTest(); return; }
    if (id === 'delete')  { _view = 'confirm'; _focus = 0; _render(); return; }
    if (id === 'cancel')  { _view = 'menu'; _focus = 0; _render(); return; }

    if (id === 'do-delete') {
      const key = _key;
      m && m.remove(key);
      _close();
      if (toast) toast.show('Configuration supprimée', false);
      return;
    }

    if (id === 'rename') {
      const key = _key, current = _displayName(key);
      _close();
      openKb('Nouveau nom — ' + current, current, (val) => _doRename(key, val));
      return;
    }

    if (id === 'reconfig') {
      sessionStorage.setItem('mapper_deviceId', _key);
      sessionStorage.setItem('mapper_type', 'remote');
      _stopTest();
      window.location.href = 'mapper.html';
    }
  }

  function _doRename(key, val) {
    val = (val || '').trim();
    if (!val) return;
    const m  = _getMapper();
    const bt = _btFor(key);
    const done = () => { renderDeviceMaps(true); if (toast) toast.show('Renommé : ' + val, false); };

    if (bt && window.xeLauncher && window.xeLauncher.btRename) {
      /* Même nom partout (Bluetooth, Audio, Manettes) */
      window.xeLauncher.btRename(bt.mac, val).then(ok => {
        if (!ok) { if (toast) toast.show('Erreur renommage', true); return; }
        m && m.setAlias(key, '');
        return _refreshBt().then(() => {
          if (XeSettings.Audio && XeSettings.Audio.refreshSinks) XeSettings.Audio.refreshSinks();
          done();
        });
      });
    } else {
      m && m.setAlias(key, val);
      done();
    }
  }

  /* ── Navigation clavier / manette ── */
  function deviceActionKey(key) {
    if (key === 'Triangle') key = 'Enter';
    const isBack = key === 'Escape' || key === 'Backspace' || key === 'Back';

    if (_view === 'test') {
      if (!isBack) return;
      const now = Date.now();
      if (now - _testBackAt < 1200) { _stopTest(); _view = 'menu'; _render(); }
      else { _testBackAt = now; }
      return;
    }

    if (_view === 'info') {
      if (key === 'Enter' || isBack) { _view = 'menu'; _render(); }
      return;
    }

    if (_view === 'confirm') {
      if (key === 'ArrowUp' || key === 'ArrowLeft')        { _focus = 0; _render(); }
      else if (key === 'ArrowDown' || key === 'ArrowRight') { _focus = 1; _render(); }
      else if (key === 'Enter')                             { _exec(_items[_focus].id); }
      else if (isBack)                                      { _view = 'menu'; _focus = 0; _render(); }
      return;
    }

    /* menu */
    if (key === 'ArrowUp')        { _focus = Math.max(0, _focus - 1); _render(); }
    else if (key === 'ArrowDown') { _focus = Math.min(_items.length - 1, _focus + 1); _render(); }
    else if (key === 'Enter')     { _exec(_items[_focus].id); }
    else if (isBack)              { _close(); updateContentFocus(); }
  }

  return {
    _setMapper,
    renderDeviceMaps,
    openDeviceAction,
    deviceActionKey,
    /* Rétrocompatibilité (gpDebug supprimé) */
    closeGpDebug: () => {},
    openGpDebug:  () => {},
  };
})();
