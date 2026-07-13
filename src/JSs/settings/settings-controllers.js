/**
 * settings-controllers.js
 * Onglet Manettes : liste des mappages par nom d'appareil,
 * actions : renommer, supprimer la config, reconfigurer.
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.Controllers = (() => {

  /* ─────────────────────────────────────────────────────────────
     LISTE DES MAPPAGES
  ───────────────────────────────────────────────────────────── */

  /* Référence à l'instance InputMapper (injectée par settings-core après init) */
  let _mapper = null;
  function _setMapper(m) { _mapper = m; }

  /* Accès sûr au mapper */
  function _getMapper() {
    /* D'abord la ref injectée, sinon la variable globale 'mapper' de core */
    return _mapper || (typeof mapper !== 'undefined' ? mapper : null);
  }
  function renderDeviceMaps() {
    const c = document.getElementById('deviceMapList');
    if (!c) return;
    c.innerHTML = '';

    const keys = _getMapper()?.getAllKeys() || [];
    if (!keys.length) {
      c.innerHTML = '<div style="color:var(--text-dim);font-family:var(--font-mono);' +
        'font-size:var(--fs-hint);letter-spacing:2px;text-transform:uppercase;' +
        'padding:clamp(10px,1.5vh,16px) clamp(20px,3vw,40px)">Aucun appareil configuré</div>';
      return;
    }

    keys.forEach(deviceKey => {
      const el = document.createElement('div');
      el.className = 'device-item';
      el.dataset.deviceKey = deviceKey;

      const isRemote  = deviceKey === REMOTE_DEVICE_ID;
      const shortName = isRemote
        ? '📺 Télécommande'
        : (deviceKey.length > 50 ? deviceKey.slice(0, 50) + '…' : deviceKey);

      const map        = _getMapper()?.get(deviceKey);
      const mappedKeys = XeInput.ACTION_KEYS.map(a => {
        const raw = map?.[a.id];
        return raw ? (a.label + ': ' + (XeInput.prettyRaw(raw) || raw)) : null;
      }).filter(Boolean).join(' · ');

      el.innerHTML =
        `<span class="device-icon">🎮</span>` +
        `<div style="flex:1;min-width:0">` +
          `<div class="device-name">${shortName}</div>` +
          (mappedKeys
            ? `<div style="font-size:var(--fs-hint);color:var(--text-hint);` +
              `letter-spacing:1px;margin-top:4px;white-space:nowrap;` +
              `overflow:hidden;text-overflow:ellipsis">${mappedKeys}</div>`
            : '') +
        `</div>` +
        `<span style="font-size:var(--fs-hint);color:rgba(0,164,220,0.6);` +
        `letter-spacing:1px;flex-shrink:0;margin-left:12px">configuré</span>`;

      el.addEventListener('click', () => openDeviceAction(deviceKey, shortName));
      c.appendChild(el);
    });
    updateContentFocus();
  }

  /* ─────────────────────────────────────────────────────────────
     OVERLAY D'ACTIONS APPAREIL
  ───────────────────────────────────────────────────────────── */
  let _actionKey   = null;
  let _actionName  = '';
  let _actionItems = [];
  let _actionFocus = 0;

  function openDeviceAction(deviceKey, displayName) {
    _actionKey   = deviceKey;
    _actionName  = displayName;
    _actionFocus = 0;
    _actionItems = [
      { label: '✏  Renommer',           id: 'rename'   },
      { label: '↺  Reconfigurer',        id: 'reconfig' },
      { label: '✕  Supprimer la config', id: 'delete', danger: true },
    ];

    const overlay = document.getElementById('deviceActionOverlay');
    document.getElementById('deviceActionTitle').textContent = displayName;
    document.getElementById('deviceActionSub').textContent   = deviceKey !== displayName ? deviceKey : '';
    _renderDeviceActionList();
    overlay.classList.add('visible');
    screen = 'deviceAction';
  }

  function _renderDeviceActionList() {
    const list = document.getElementById('deviceActionList');
    if (!list) return;
    list.innerHTML = '';
    _actionItems.forEach((item, i) => {
      const btn = document.createElement('div');
      btn.className = 'bt-action-btn'
        + (item.danger    ? ' danger'  : '')
        + (i === _actionFocus ? ' focused' : '');
      btn.textContent = item.label;
      btn.addEventListener('click', () => { _actionFocus = i; _executeDeviceAction(item.id); });
      list.appendChild(btn);
    });
  }

  function _executeDeviceAction(id) {
    const overlay = document.getElementById('deviceActionOverlay');
    if (id === 'delete') {
      overlay.classList.remove('visible');
      screen = 'main';
      _getMapper()?.remove(_actionKey);
      renderDeviceMaps();
      if (toast) toast.show('Configuration supprimée', false);
      return;
    }
    if (id === 'rename') {
      overlay.classList.remove('visible');
      screen = 'main';
      openKb('Nouveau nom — ' + _actionName, _actionName, (val) => {
        if (!val || !val.trim()) return;
        _getMapper()?.rename(_actionKey, val.trim());
        renderDeviceMaps();
        if (toast) toast.show('Renommé : ' + val.trim(), false);
      });
      return;
    }
    if (id === 'reconfig') {
      overlay.classList.remove('visible');
      screen = 'main';
      /* Passer dans mapper.html avec l'identifiant existant */
      sessionStorage.setItem('mapper_deviceId', _actionKey);
      sessionStorage.setItem('mapper_type', 'remote');
      window.location.href = 'mapper.html';
      return;
    }
  }

  function deviceActionKey(key) {
    if (key === 'ArrowUp') {
      _actionFocus = Math.max(0, _actionFocus - 1);
      _renderDeviceActionList();
    } else if (key === 'ArrowDown') {
      _actionFocus = Math.min(_actionItems.length - 1, _actionFocus + 1);
      _renderDeviceActionList();
    } else if (key === 'Enter') {
      _executeDeviceAction(_actionItems[_actionFocus].id);
    } else if (key === 'Escape' || key === 'Backspace' || key === 'Back') {
      document.getElementById('deviceActionOverlay').classList.remove('visible');
      screen = 'main';
      updateContentFocus();
    }
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
