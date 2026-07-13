/**
 * settings-bluetooth.js
 * Onglet Bluetooth : appareils appairés, scan, masquage, overlay d'actions.
 * Fixes : pas de gap entre les rows, démasquage fonctionnel, connect après appairage.
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.Bluetooth = (() => {

  /* ── État ── */
  let btPowered     = false;
  let btPaired      = [];
  let btScanResults = [];
  let hiddenBtDevices = [];
  let btHiddenListExpanded = false;
  let btActionOverlayActive = false;
  let btActionDev   = null;
  let btActionItems = [];
  let btActionFocusIdx = 0;

  /* ─────────────────────────────────────────────────────────────
     APPAREILS MASQUÉS
  ───────────────────────────────────────────────────────────── */
  function loadHiddenDevices() {
    try { hiddenBtDevices = JSON.parse(localStorage.getItem('xelauncher_hidden_bt') || '[]'); } catch(e) { hiddenBtDevices = []; }
    _updateHiddenCount();
  }

  function saveHiddenDevices() {
    localStorage.setItem('xelauncher_hidden_bt', JSON.stringify(hiddenBtDevices));
    _updateHiddenCount();
  }

  function _updateHiddenCount() {
    const el = document.getElementById('hiddenBtCount');
    if (el) el.textContent = hiddenBtDevices.length;
  }

  function toggleHiddenList() {
    btHiddenListExpanded = !btHiddenListExpanded;
    const hl = document.getElementById('hiddenBtList');
    if (hl) {
      hl.style.display = btHiddenListExpanded ? 'block' : 'none';
      if (btHiddenListExpanded) renderHiddenBtList();
    }
  }

  function hideDevice(rowEl, idx) {
    const mac = rowEl.dataset.mac;
    if (!mac) return;
    if (!hiddenBtDevices.includes(mac)) hiddenBtDevices.push(mac);
    saveHiddenDevices();
    renderBtPaired();
    renderBtScan();
    if (btHiddenListExpanded) renderHiddenBtList();
    if (typeof rowFocusMap !== 'undefined') {
      rowFocusMap['bluetooth'] = Math.min(idx, getContentRows().length - 1);
    }
    updateContentFocus();
  }

  /* ─────────────────────────────────────────────────────────────
     CHARGEMENT
  ───────────────────────────────────────────────────────────── */
  function load() {
    if (!window.xeLauncher) return;
    window.xeLauncher.btStatus().then(s => {
      btPowered = s.powered;
      const tog = document.getElementById('btToggle');
      if (tog) tog.className = 'toggle' + (btPowered ? ' on' : '');
    });
    window.xeLauncher.btListPaired().then(devs => {
      btPaired = devs || [];
      renderBtPaired();
    });
  }

  function togglePower(rowEl) {
    if (!window.xeLauncher) return;
    btPowered = !btPowered;
    window.xeLauncher.btPower(btPowered);
    const tog = rowEl.querySelector('.toggle');
    if (tog) tog.className = 'toggle' + (btPowered ? ' on' : '');
    if (typeof toast !== 'undefined' && toast) toast.show(btPowered ? 'Bluetooth activé' : 'Bluetooth désactivé', false);
  }

  /* ─────────────────────────────────────────────────────────────
     RENDU — liste appairés et scannés (sans gap entre rows)
  ───────────────────────────────────────────────────────────── */
  function renderBtPaired() {
    const c = document.getElementById('btPairedList');
    if (!c) return;
    c.innerHTML = '';
    const visible = btPaired.filter(d => !hiddenBtDevices.includes(d.mac));
    if (!visible.length) {
      c.innerHTML = '<div style="color:var(--text-dim);font-family:inherit;font-size:clamp(11px,1.3vw,14px);letter-spacing:2px;text-transform:uppercase;padding:10px 16px">Aucun appareil appairé</div>';
      updateContentFocus(); return;
    }
    visible.forEach(dev => {
      const el = document.createElement('div');
      el.className = 'bt-item';
      el.dataset.mac    = dev.mac;
      el.dataset.bttype = 'paired';
      const icon = dev.type === 'audio' ? '🎧' : dev.type === 'keyboard' ? '⌨️' : '🎮';
      el.innerHTML =
        `<span class="bt-icon">${icon}</span>` +
        `<span class="bt-name">${dev.name || dev.mac}</span>` +
        (dev.connected ? '<span class="bt-connected">● connecté</span>' : '') +
        `<span class="bt-mac">${dev.mac}</span>`;
      el.addEventListener('click', () => openActionOverlay(dev, true));
      c.appendChild(el);
    });
    _renderBtHiddenSection();
    updateContentFocus();
  }

  function renderBtScan() {
    const c = document.getElementById('btScanList');
    if (!c) return;
    c.innerHTML = '';
    const visible = btScanResults.filter(d => !hiddenBtDevices.includes(d.mac));
    if (!btScanResults.length) { updateContentFocus(); return; }
    if (!visible.length) {
      c.innerHTML = '<div style="color:var(--text-dim);font-family:inherit;font-size:clamp(11px,1.3vw,14px);letter-spacing:2px;text-transform:uppercase;padding:10px 16px">Aucun appareil trouvé</div>';
      updateContentFocus(); return;
    }
    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:12px 16px 4px;font-family:inherit;font-size:clamp(9px,1vw,11px);letter-spacing:3px;color:rgba(0,164,220,0.5);text-transform:uppercase;';
    hdr.textContent = 'Appareils trouvés';
    c.appendChild(hdr);
    visible.forEach(dev => {
      const el = document.createElement('div');
      el.className = 'bt-item';
      el.dataset.mac    = dev.mac;
      el.dataset.bttype = 'scan';
      el.innerHTML =
        `<span class="bt-icon">📡</span>` +
        `<span class="bt-name">${dev.name || dev.mac}</span>` +
        `<span class="bt-mac">${dev.mac}</span>`;
      el.addEventListener('click', () => openActionOverlay(dev, false));
      c.appendChild(el);
    });
    updateContentFocus();
  }

  function _renderBtHiddenSection() {
    _updateHiddenCount();
    if (btHiddenListExpanded) renderHiddenBtList();
  }

  function renderHiddenBtList() {
    const c = document.getElementById('hiddenBtList');
    if (!c) return;
    c.innerHTML = '';
    const allKnown = [...btPaired, ...btScanResults];
    if (!hiddenBtDevices.length) {
      c.innerHTML = '<div style="color:var(--text-dim);font-family:inherit;font-size:clamp(11px,1.3vw,14px);letter-spacing:2px;text-transform:uppercase;padding:10px 16px">Aucun appareil masqué</div>';
      updateContentFocus(); return;
    }
    hiddenBtDevices.forEach((mac, idx) => {
      const dev  = allKnown.find(d => d.mac === mac);
      const name = dev ? (dev.name || dev.mac) : mac;
      const el   = document.createElement('div');
      el.className = 'bt-item bt-item-hidden';
      el.dataset.mac      = mac;
      el.dataset.btHidden = '1';
      el.innerHTML =
        `<span class="bt-icon">👁</span>` +
        `<span class="bt-name" style="opacity:0.5">${name}</span>` +
        `<span class="bt-mac">${mac}</span>` +
        `<span style="font-size:clamp(10px,1.1vw,13px);color:rgba(0,164,220,0.7);letter-spacing:1px;margin-left:8px">→ démasquer</span>`;
      el.addEventListener('click', () => {
        const i = hiddenBtDevices.indexOf(mac);
        if (i >= 0) hiddenBtDevices.splice(i, 1);
        saveHiddenDevices();
        renderBtPaired();
        renderBtScan();
        renderHiddenBtList();
        updateContentFocus();
        if (typeof toast !== 'undefined' && toast) toast.show('Appareil démasqué', false);
      });
      c.appendChild(el);
    });
    updateContentFocus();
  }

  /* ─────────────────────────────────────────────────────────────
     SCAN
  ───────────────────────────────────────────────────────────── */
  function doScan() {
    if (!window.xeLauncher) { if (typeof toast !== 'undefined' && toast) toast.show('API non disponible', true); return; }
    if (!btPowered)         { if (typeof toast !== 'undefined' && toast) toast.show("Activez le Bluetooth d'abord", true); return; }
    const statusEl = document.getElementById('btScanStatus');
    if (statusEl) statusEl.textContent = '…';
    const loadingText = document.getElementById('loadingText');
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingText) loadingText.textContent = 'Scan Bluetooth — Appuyez sur SYNC sur la Wiimote…';
    if (loadingOverlay) loadingOverlay.classList.add('visible');
    let remaining = 12;
    const countdown = setInterval(() => {
      remaining--;
      if (loadingText) loadingText.textContent = `Scan Bluetooth (${remaining}s) — Appuyez sur SYNC…`;
      if (remaining <= 0) clearInterval(countdown);
    }, 1000);
    window.xeLauncher.btScan().then(devs => {
      clearInterval(countdown);
      if (loadingOverlay) loadingOverlay.classList.remove('visible');
      btScanResults = (devs || []).filter(d => !btPaired.find(p => p.mac === d.mac));
      if (statusEl) statusEl.textContent = btScanResults.length + ' trouvé(s)';
      renderBtScan();
    });
  }

  /* ─────────────────────────────────────────────────────────────
     OVERLAY D'ACTIONS
  ───────────────────────────────────────────────────────────── */
  function openActionOverlay(dev, isPaired) {
    btActionDev   = { ...dev, paired: isPaired };
    btActionItems = [];
    if (isPaired) {
      btActionItems.push(dev.connected
        ? { label: '⏏  Déconnecter', action: 'disconnect' }
        : { label: '⚡  Connecter',   action: 'connect'    }
      );
      btActionItems.push({ label: '✏  Renommer',            action: 'rename' });
      btActionItems.push({ label: "✕  Retirer l'appairage", action: 'remove', danger: true });
    } else {
      btActionItems.push({ label: '⚡  Appairer', action: 'pair' });
    }
    btActionItems.push({ label: '⊘  Masquer', action: 'hide' });
    btActionFocusIdx      = 0;
    btActionOverlayActive = true;
    if (typeof screen !== 'undefined') screen = 'btAction';
    renderActionOverlay();
    document.getElementById('btActionOverlay').classList.add('visible');
  }

  function closeActionOverlay() {
    btActionOverlayActive = false;
    btActionDev = null;
    if (typeof screen !== 'undefined') screen = 'main';
    document.getElementById('btActionOverlay').classList.remove('visible');
    updateContentFocus();
  }

  function renderActionOverlay() {
    const dev = btActionDev;
    if (!dev) return;
    document.getElementById('btActionTitle').textContent = dev.name || dev.mac;
    document.getElementById('btActionMac').textContent   = dev.mac;
    const list = document.getElementById('btActionList');
    if (!list) return;
    list.innerHTML = '';
    btActionItems.forEach((item, i) => {
      const btn = document.createElement('div');
      btn.className = 'bt-action-btn'
        + (item.danger      ? ' danger'  : '')
        + (i === btActionFocusIdx ? ' focused' : '');
      btn.textContent = item.label;
      btn.addEventListener('click', () => { btActionFocusIdx = i; executeAction(item.action); });
      list.appendChild(btn);
    });
  }

  function executeAction(action) {
    const dev = btActionDev;
    if (!dev) return;

    if (action === 'hide') {
      if (!hiddenBtDevices.includes(dev.mac)) hiddenBtDevices.push(dev.mac);
      saveHiddenDevices();
      closeActionOverlay();
      renderBtPaired();
      renderBtScan();
      return;
    }

    closeActionOverlay();

    if (action === 'connect') {
      if (!window.xeLauncher) return;
      const loadingText = document.getElementById('loadingText');
      const loadingOverlay = document.getElementById('loadingOverlay');
      if (loadingText) loadingText.textContent = 'Connexion à ' + (dev.name || dev.mac) + '…';
      if (loadingOverlay) loadingOverlay.classList.add('visible');
      window.xeLauncher.btConnect(dev.mac).then(ok => {
        if (loadingOverlay) loadingOverlay.classList.remove('visible');
        if (typeof toast !== 'undefined' && toast) toast.show(ok ? '● Connecté : ' + (dev.name || dev.mac) : 'Échec connexion', !ok);
        load();
      });
    } else if (action === 'disconnect') {
      if (!window.xeLauncher) return;
      window.xeLauncher.btDisconnect(dev.mac).then(() => {
        if (typeof toast !== 'undefined' && toast) toast.show('Déconnecté : ' + (dev.name || dev.mac), false);
        load();
      });
    } else if (action === 'remove') {
      if (!window.xeLauncher) return;
      const loadingText = document.getElementById('loadingText');
      const loadingOverlay = document.getElementById('loadingOverlay');
      if (loadingText) loadingText.textContent = 'Suppression de ' + (dev.name || dev.mac) + '…';
      if (loadingOverlay) loadingOverlay.classList.add('visible');
      window.xeLauncher.btRemove(dev.mac).then(ok => {
        if (loadingOverlay) loadingOverlay.classList.remove('visible');
        if (typeof toast !== 'undefined' && toast) toast.show(ok ? 'Appairage supprimé' : 'Erreur', !ok);
        load();
      });
    } else if (action === 'pair') {
      if (!window.xeLauncher) return;
      const isWiimote = /nintendo|rvl|wiimote/i.test(dev.name || '');
      const loadingText = document.getElementById('loadingText');
      const loadingOverlay = document.getElementById('loadingOverlay');
      if (loadingText) loadingText.textContent = isWiimote
        ? 'Connexion Wiimote — Appuyez sur SYNC…'
        : 'Appairage de ' + (dev.name || dev.mac) + '…';
      if (loadingOverlay) loadingOverlay.classList.add('visible');
      window.xeLauncher.btPair(dev.mac).then(ok => {
        if (!ok) {
          if (loadingOverlay) loadingOverlay.classList.remove('visible');
          if (typeof toast !== 'undefined' && toast) toast.show('Échec appairage', true);
          return;
        }
        // Appairage réussi → connecter immédiatement
        if (loadingText) loadingText.textContent = 'Connexion à ' + (dev.name || dev.mac) + '…';
        window.xeLauncher.btConnect(dev.mac).then(connOk => {
          if (loadingOverlay) loadingOverlay.classList.remove('visible');
          if (typeof toast !== 'undefined' && toast) {
            toast.show(connOk
              ? '● Appairé et connecté : ' + (dev.name || dev.mac)
              : 'Appairé — connexion manuelle requise', !connOk);
          }
          load();
          if (typeof mapper !== 'undefined' && mapper && !mapper.has(dev.mac)) {
            if (typeof openMapperUI === 'function') openMapperUI(dev.mac);
          }
        });
      });
    } else if (action === 'rename') {
      if (typeof openKb === 'function') {
        openKb('Nouveau nom — ' + (dev.name || dev.mac), dev.name || '', (val) => {
          if (!val || !window.xeLauncher) return;
          window.xeLauncher.btRename(dev.mac, val).then(ok => {
            if (typeof toast !== 'undefined' && toast) toast.show(ok ? 'Renommé : ' + val : 'Erreur renommage', !ok);
            if (ok) load();
          });
        });
      }
    }
  }

  /* ── Navigation clavier dans l'overlay ── */
  function actionKey(key) {
    if (key === 'ArrowUp') {
      btActionFocusIdx = Math.max(0, btActionFocusIdx - 1);
      renderActionOverlay();
    } else if (key === 'ArrowDown') {
      btActionFocusIdx = Math.min(btActionItems.length - 1, btActionFocusIdx + 1);
      renderActionOverlay();
    } else if (key === 'Enter') {
      const item = btActionItems[btActionFocusIdx];
      if (item) executeAction(item.action);
    } else if (key === 'Escape' || key === 'Backspace' || key === 'Back') {
      closeActionOverlay();
    }
  }

  /* ── API publique ── */
  return {
    get btPaired()       { return btPaired; },
    get btScanResults()  { return btScanResults; },

    load, togglePower,
    loadHiddenDevices, saveHiddenDevices, toggleHiddenList, hideDevice,
    renderBtPaired, renderBtScan, renderHiddenBtList,
    doScan,
    openActionOverlay, closeActionOverlay, renderActionOverlay, actionKey,
  };
})();
