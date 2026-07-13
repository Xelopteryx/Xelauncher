/**
 * settings-network.js
 * Onglet Réseau : scan WiFi, réseaux connus, réseaux masqués,
 * interfaces réseau, overlay de configuration d'interface.
 *
 * Fixes :
 * - Compteur = réseaux visibles (hors masqués ET hors connus)
 * - Réseaux masqués : toujours afficher signal + cadenas, mis à jour au scan
 * - Passerelle eth affichée correctement
 * - Scan en continu possible depuis overlay réseaux connus
 * - Compteur mis à jour quand on masque un réseau après scan
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.Network = (() => {

  /* ── État ── */
  let wifiNetworks    = [];
  let wifiCurrentSSID = '';
  let ifaceList       = [];
  let ifaceConfigState = {};
  let hiddenNetworks  = [];
  let hiddenListExpanded = false;
  let knownNetworks   = [];
  let knownOverlayActive  = false;
  let knownOverlayFocusIdx = 0;
  let knownOverlayColIdx   = 0;
  let knownReorderMode = false;
  let knownReorderIdx  = -1;
  let ifaceOverlayActive = false;
  let ifaceOverlayIdx    = -1;
  let ifaceOverlayRowIdx = 0;
  let ifacePollingTimer  = null;
  let _backgroundScanTimer = null;  // scan périodique en arrière-plan pour overlay connus

  const IFACE_FIELDS = [
    { key: 'mode',   label: 'Mode',       type: 'toggle' },
    { key: 'ip',     label: 'Adresse IP', type: 'text'   },
    { key: 'mask',   label: 'Masque',     type: 'text'   },
    { key: 'gw',     label: 'Passerelle', type: 'text'   },
    { key: 'dns',    label: 'DNS',        type: 'text'   },
    { key: 'apply',  label: 'Appliquer',  type: 'action' },
    { key: 'cancel', label: 'Annuler',    type: 'action' },
  ];

  /* ── Compteur visible ── */
  function _visibleCount() {
    const knownSSIDs = new Set(knownNetworks.map(n => n.ssid));
    return wifiNetworks.filter(n => !hiddenNetworks.includes(n.ssid) && !knownSSIDs.has(n.ssid)).length;
  }

  function _updateScanStatus() {
    const el = document.getElementById('wifiScanStatus');
    if (!el) return;
    const count = _visibleCount();
    if (wifiNetworks.length === 0) { el.textContent = '↻'; return; }
    el.textContent = count === 0 ? '0 réseau' : count === 1 ? '1 réseau' : count + ' réseaux';
  }

  /* ─────────────────────────────────────────────────────────────
     RÉSEAUX MASQUÉS
  ───────────────────────────────────────────────────────────── */
  function loadHiddenNetworks() {
    try { hiddenNetworks = JSON.parse(localStorage.getItem('xelauncher_hidden_nets') || '[]'); } catch(e) { hiddenNetworks = []; }
    _updateHiddenNetCount();
  }

  function saveHiddenNetworks() {
    localStorage.setItem('xelauncher_hidden_nets', JSON.stringify(hiddenNetworks));
    _updateHiddenNetCount();
  }

  function _updateHiddenNetCount() {
    const el = document.getElementById('hiddenNetCount');
    if (el) el.textContent = hiddenNetworks.length;
  }

  function toggleHiddenList() {
    hiddenListExpanded = !hiddenListExpanded;
    const hl = document.getElementById('hiddenNetList');
    if (hl) {
      hl.style.display = hiddenListExpanded ? 'block' : 'none';
      if (hiddenListExpanded) renderHiddenList();
    }
  }

  function toggleNetworkVisibility(rowEl, idx) {
    const ssid = rowEl.dataset.ssid;
    if (!ssid) return;
    if (hiddenNetworks.includes(ssid)) {
      hiddenNetworks.splice(hiddenNetworks.indexOf(ssid), 1);
    } else {
      hiddenNetworks.push(ssid);
    }
    saveHiddenNetworks();
    renderWifiList();
    _updateScanStatus();
    if (hiddenListExpanded) renderHiddenList();
    if (typeof rowFocusMap !== 'undefined') {
      rowFocusMap[activeTab] = Math.min(idx, getContentRows().length - 1);
    }
    updateContentFocus();
  }

  /* ─────────────────────────────────────────────────────────────
     RÉSEAUX CONNUS
  ───────────────────────────────────────────────────────────── */
  function loadKnownNetworks() {
    if (!window.xeLauncher) return;
    window.xeLauncher.getKnownNetworks().then(nets => {
      knownNetworks = nets || [];
      _updateKnownNetCount();
    });
  }

  function _updateKnownNetCount() {
    const el = document.getElementById('knownNetCount');
    if (el) el.textContent = knownNetworks.length ? knownNetworks.length + '' : '—';
  }

  function saveKnownNetworksPriority() {
    if (!window.xeLauncher) return;
    window.xeLauncher.setKnownNetworksPriority(knownNetworks.map(n => n.ssid))
      .then(ok => { if (!ok && typeof toast !== 'undefined' && toast) toast.show('Erreur sauvegarde priorités', true); });
  }

  function openKnownOverlay() {
    knownOverlayActive   = true;
    knownOverlayFocusIdx = 0;
    knownOverlayColIdx   = 0;
    knownReorderMode     = false;
    knownReorderIdx      = -1;
    if (typeof screen !== 'undefined') screen = 'knownOverlay';
    document.getElementById('knownOverlay').classList.add('visible');
    renderKnownOverlay();
    _refreshKnownData();
    // Scan en arrière-plan toutes les 8s pour actualiser la disponibilité
    _startBackgroundScan();
  }

  function _refreshKnownData() {
    if (!window.xeLauncher) return;
    Promise.all([
      window.xeLauncher.getKnownNetworks(),
      window.xeLauncher.wifiCurrentSSID(),
      window.xeLauncher.wifiScan()
    ]).then(([nets, ssid, scanned]) => {
      knownNetworks   = nets || [];
      wifiCurrentSSID = ssid || '';
      if (scanned) wifiNetworks = scanned;
      _updateKnownNetCount();
      renderKnownOverlay();
    });
  }

  function _startBackgroundScan() {
    _stopBackgroundScan();
    _backgroundScanTimer = setInterval(() => {
      if (!knownOverlayActive || !window.xeLauncher) return;
      window.xeLauncher.wifiScan().then(nets => {
        if (nets) { wifiNetworks = nets; }
        window.xeLauncher.wifiCurrentSSID().then(ssid => {
          wifiCurrentSSID = ssid || '';
          renderKnownOverlay();
        });
      });
    }, 8000);
  }

  function _stopBackgroundScan() {
    if (_backgroundScanTimer) { clearInterval(_backgroundScanTimer); _backgroundScanTimer = null; }
  }

  function closeKnownOverlay() {
    knownOverlayActive = false;
    knownReorderMode   = false;
    _stopBackgroundScan();
    if (typeof screen !== 'undefined') screen = 'main';
    document.getElementById('knownOverlay').classList.remove('visible');
    updateContentFocus();
  }

  function renderKnownOverlay() {
    const overlay = document.getElementById('knownOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';

    const title = document.createElement('div');
    title.className   = 'iface-overlay-title';
    title.textContent = 'Réseaux connus';
    overlay.appendChild(title);

    const hint = document.createElement('div');
    hint.className   = 'iface-overlay-hint';
    hint.textContent = knownReorderMode
      ? '↑ ↓  Déplacer  •  Entrée  Valider  •  Retour  Annuler'
      : '↑ ↓  Naviguer  •  →  Actions  •  Entrée  Confirmer  •  Retour  Fermer';
    overlay.appendChild(hint);

    if (!knownNetworks.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim);font-family:inherit;font-size:clamp(12px,1.4vw,16px);letter-spacing:2px;text-transform:uppercase;padding:20px 0';
      empty.textContent = 'Aucun réseau enregistré';
      overlay.appendChild(empty);
      const closeBtn = document.createElement('div');
      closeBtn.className = 'known-overlay-row' + (knownOverlayFocusIdx === 0 ? ' focused' : '');
      closeBtn.style.cssText = 'justify-content:center;margin-top:16px';
      closeBtn.textContent = '← Fermer';
      overlay.appendChild(closeBtn);
      return;
    }

    const lockSVG = `<svg width="13" height="15" viewBox="0 0 12 14" fill="none" style="flex-shrink:0;margin-right:4px"><rect x="1" y="6" width="10" height="8" rx="1" fill="none" stroke="rgba(0,164,220,0.6)" stroke-width="1.2"/><path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="rgba(0,164,220,0.6)" stroke-width="1.2"/></svg>`;
    const lockOpenSVG = `<svg width="13" height="15" viewBox="0 0 12 14" fill="none" style="flex-shrink:0;margin-right:4px;opacity:0.35"><rect x="1" y="6" width="10" height="8" rx="1" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/><path d="M3 6V4a3 3 0 0 1 6 0" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/></svg>`;
    const availableSSIDs = new Set(wifiNetworks.map(n => n.ssid));

    knownNetworks.forEach((net, i) => {
      const isCurrent    = net.ssid === wifiCurrentSSID;
      const isAvail      = availableSSIDs.has(net.ssid);
      const isSecure     = net.security && net.security.trim() && net.security !== 'Open';
      const isFocused    = !knownReorderMode && knownOverlayFocusIdx === i;
      const isReordering = knownReorderMode && knownReorderIdx === i;
      const netData      = wifiNetworks.find(n => n.ssid === net.ssid);
      const sig          = netData ? parseInt(netData.signal || 0) : 0;
      const lit          = sig > 75 ? 4 : sig > 50 ? 3 : sig > 25 ? 2 : (sig > 0 ? 1 : 0);

      const row = document.createElement('div');
      row.className = 'known-overlay-row'
        + (isCurrent    ? ' current'        : '')
        + (isFocused    ? ' focused'         : '')
        + (isReordering ? ' reorder-focused' : '')
        + (!isAvail     ? ' unavailable'     : '');

      const left = document.createElement('div');
      left.className = 'known-overlay-left';

      // Barres signal (toujours affichées)
      const bars = [1,2,3,4].map(b => `<span class="bar${b <= lit ? ' lit' : ''}"></span>`).join('');
      const sigSpan = document.createElement('span');
      sigSpan.className = 'wifi-signal';
      sigSpan.style.marginRight = '6px';
      sigSpan.innerHTML = bars;
      left.appendChild(sigSpan);

      left.insertAdjacentHTML('beforeend', isSecure ? lockSVG : lockOpenSVG);
      const ssidSpan = document.createElement('span');
      ssidSpan.className   = 'known-overlay-ssid';
      ssidSpan.textContent = net.ssid;
      left.appendChild(ssidSpan);
      if (isCurrent) {
        const cs = document.createElement('span');
        cs.className   = 'known-overlay-connected';
        cs.textContent = '● connecté';
        left.appendChild(cs);
      }
      row.appendChild(left);

      // Actions (seulement si pas en mode réordonnancement, et uniquement boutons — pas de sélection de ligne)
      const actions = document.createElement('div');
      actions.className = 'known-overlay-actions';

      if (!knownReorderMode) {
        const colFocus = isFocused ? knownOverlayColIdx : -1;

        // Bouton Connecter/Déconnecter
        const actionBtn = document.createElement('div');
        actionBtn.className = 'known-prio-btn known-action-btn option-item'
          + (isCurrent ? ' known-disconnect' : '')
          + (colFocus === 1 ? ' focused' : '');
        actionBtn.textContent = isCurrent ? 'Déconnecter' : 'Connecter';
        actionBtn.addEventListener('click', () => { isCurrent ? doKnownDisconnect() : doKnownConnect(net); });
        actions.appendChild(actionBtn);

        // Bouton Supprimer
        const forgetBtn = document.createElement('div');
        forgetBtn.className   = 'known-prio-btn option-item known-forget-btn' + (colFocus === 2 ? ' focused' : '');
        forgetBtn.textContent = '✕';
        forgetBtn.title       = 'Supprimer';
        forgetBtn.addEventListener('click', () => doKnownForget(i));
        actions.appendChild(forgetBtn);

        // Bouton monter
        const upBtn = document.createElement('div');
        upBtn.className   = 'known-prio-btn option-item' + (i === 0 ? ' disabled' : '') + (colFocus === 3 ? ' focused' : '');
        upBtn.textContent = '↑';
        upBtn.title       = 'Monter';
        if (i > 0) upBtn.addEventListener('click', () => { moveKnownNet(i, -1); knownOverlayFocusIdx--; saveKnownNetworksPriority(); renderKnownOverlay(); });
        actions.appendChild(upBtn);

        // Bouton descendre
        const downBtn = document.createElement('div');
        downBtn.className   = 'known-prio-btn option-item' + (i === knownNetworks.length - 1 ? ' disabled' : '') + (colFocus === 4 ? ' focused' : '');
        downBtn.textContent = '↓';
        downBtn.title       = 'Descendre';
        if (i < knownNetworks.length - 1) downBtn.addEventListener('click', () => { moveKnownNet(i, 1); knownOverlayFocusIdx++; saveKnownNetworksPriority(); renderKnownOverlay(); });
        actions.appendChild(downBtn);
      }
      row.appendChild(actions);

      const prioLabel = document.createElement('div');
      prioLabel.style.cssText = 'font-family:inherit;font-size:clamp(10px,1.1vw,13px);letter-spacing:1px;color:rgba(0,164,220,0.35);min-width:26px;text-align:right';
      prioLabel.textContent = '#' + (i + 1);
      row.appendChild(prioLabel);
      overlay.appendChild(row);
    });

    const closeRow = document.createElement('div');
    const isCloseFocused = !knownReorderMode && knownOverlayFocusIdx === knownNetworks.length;
    closeRow.className   = 'known-overlay-row' + (isCloseFocused ? ' focused' : '');
    closeRow.style.cssText = 'justify-content:center;margin-top:8px;opacity:0.7';
    closeRow.textContent = '← Fermer';
    closeRow.addEventListener('click', closeKnownOverlay);
    overlay.appendChild(closeRow);
  }

  function knownOverlayKey(key) {
    const total = knownNetworks.length;
    if (knownReorderMode) {
      if (key === 'ArrowUp' && knownReorderIdx > 0) {
        moveKnownNet(knownReorderIdx, -1); knownReorderIdx--; knownOverlayFocusIdx = knownReorderIdx; renderKnownOverlay();
      } else if (key === 'ArrowDown' && knownReorderIdx < knownNetworks.length - 1) {
        moveKnownNet(knownReorderIdx, 1); knownReorderIdx++; knownOverlayFocusIdx = knownReorderIdx; renderKnownOverlay();
      } else if (key === 'Enter' || key === 'Escape' || key === 'Backspace' || key === 'Back') {
        if (key === 'Enter') saveKnownNetworksPriority();
        knownReorderMode = false; knownReorderIdx = -1; renderKnownOverlay();
      }
      return;
    }
    const onNetRow = knownOverlayFocusIdx < total;
    if      (key === 'ArrowUp')   { knownOverlayFocusIdx = Math.max(0, knownOverlayFocusIdx - 1); knownOverlayColIdx = 0; renderKnownOverlay(); }
    else if (key === 'ArrowDown') { knownOverlayFocusIdx = Math.min(total, knownOverlayFocusIdx + 1); knownOverlayColIdx = 0; renderKnownOverlay(); }
    else if (key === 'ArrowRight' && onNetRow) { knownOverlayColIdx = Math.min(4, knownOverlayColIdx + 1); renderKnownOverlay(); }
    else if (key === 'ArrowLeft') { if (knownOverlayColIdx > 0) { knownOverlayColIdx--; renderKnownOverlay(); } }
    else if (key === 'Enter') {
      if (knownOverlayFocusIdx === total) { closeKnownOverlay(); }
      else if (knownOverlayColIdx === 0)  { knownOverlayColIdx = 1; renderKnownOverlay(); }
      else {
        const net = knownNetworks[knownOverlayFocusIdx];
        if (!net) return;
        const i = knownOverlayFocusIdx;
        const isCurrent = net.ssid === wifiCurrentSSID;
        if      (knownOverlayColIdx === 1) { isCurrent ? doKnownDisconnect() : doKnownConnect(net); }
        else if (knownOverlayColIdx === 2) { doKnownForget(i); }
        else if (knownOverlayColIdx === 3 && i > 0) { moveKnownNet(i, -1); knownOverlayFocusIdx--; saveKnownNetworksPriority(); renderKnownOverlay(); }
        else if (knownOverlayColIdx === 4 && i < knownNetworks.length - 1) { moveKnownNet(i, 1); knownOverlayFocusIdx++; saveKnownNetworksPriority(); renderKnownOverlay(); }
      }
    }
    else if (key === 'Escape' || key === 'Backspace' || key === 'Back') {
      if (knownOverlayColIdx > 0) { knownOverlayColIdx = 0; renderKnownOverlay(); } else { closeKnownOverlay(); }
    }
  }

  function moveKnownNet(idx, dir) {
    const target = idx + dir;
    if (target < 0 || target >= knownNetworks.length) return;
    const tmp = knownNetworks[idx]; knownNetworks[idx] = knownNetworks[target]; knownNetworks[target] = tmp;
  }

  function doKnownConnect(net) {
    if (!window.xeLauncher) return;
    closeKnownOverlay();
    doWifiConnect(net.ssid, (net.security && net.security.trim() && net.security !== 'Open') ? null : '');
  }

  function doKnownDisconnect() {
    if (!window.xeLauncher) return;
    window.xeLauncher.wifiDisconnect().then(ok => {
      if (ok) { wifiCurrentSSID = ''; if (typeof toast !== 'undefined' && toast) toast.show('Déconnecté', false); renderWifiList(); }
      else if (typeof toast !== 'undefined' && toast) toast.show('Erreur déconnexion', true);
      renderKnownOverlay();
    });
  }

  function doKnownForget(idx) {
    const net = knownNetworks[idx];
    if (!net || !window.xeLauncher) return;
    window.xeLauncher.wifiForget(net.ssid).then(ok => {
      if (ok) {
        knownNetworks.splice(idx, 1);
        if (knownOverlayFocusIdx >= knownNetworks.length) knownOverlayFocusIdx = Math.max(0, knownNetworks.length - 1);
        _updateKnownNetCount();
        if (typeof toast !== 'undefined' && toast) toast.show('Réseau oublié', false);
      } else if (typeof toast !== 'undefined' && toast) { toast.show('Erreur', true); }
      renderKnownOverlay();
    });
  }

  /* ─────────────────────────────────────────────────────────────
     LISTE WIFI VISIBLE
  ───────────────────────────────────────────────────────────── */
  function renderWifiList() {
    const c = document.getElementById('wifiList');
    if (!c) return;
    c.innerHTML = '';
    const knownSSIDs = new Set(knownNetworks.map(n => n.ssid));
    const visible    = wifiNetworks.filter(n => !hiddenNetworks.includes(n.ssid) && !knownSSIDs.has(n.ssid));

    if (!visible.length) {
      c.innerHTML = '<div style="color:var(--text-dim);font-family:inherit;font-size:clamp(11px,1.3vw,14px);letter-spacing:2px;text-transform:uppercase;padding:12px 16px">Aucun réseau — lancez un scan</div>';
      updateContentFocus(); return;
    }

    const lockSVG     = `<svg width="13" height="15" viewBox="0 0 12 14" fill="none" style="flex-shrink:0"><rect x="1" y="6" width="10" height="8" rx="1" fill="none" stroke="rgba(0,164,220,0.6)" stroke-width="1.2"/><path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="rgba(0,164,220,0.6)" stroke-width="1.2"/></svg>`;
    const lockOpenSVG = `<svg width="13" height="15" viewBox="0 0 12 14" fill="none" style="flex-shrink:0;opacity:0.35"><rect x="1" y="6" width="10" height="8" rx="1" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/><path d="M3 6V4a3 3 0 0 1 6 0" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/></svg>`;

    visible.forEach(n => {
      const el = document.createElement('div');
      el.className  = 'wifi-network' + (n.ssid === wifiCurrentSSID ? ' current' : '');
      el.dataset.ssid = n.ssid;
      const sig  = parseInt(n.signal || 0);
      const lit  = sig > 75 ? 4 : sig > 50 ? 3 : sig > 25 ? 2 : 1;
      const bars = [1,2,3,4].map(b => `<span class="bar${b <= lit ? ' lit' : ''}"></span>`).join('');
      const isSecure = n.security && n.security.trim() && n.security !== 'Open';
      el.innerHTML =
        `<span class="wifi-ssid">${n.ssid}</span>` +
        `<span class="wifi-meta"><span class="wifi-signal">${bars}</span>` +
        (n.ssid === wifiCurrentSSID ? '<span style="color:#a5d6a7;font-size:13px;margin-right:4px">✓</span>' : '') +
        (isSecure ? lockSVG : lockOpenSVG) +
        `<span class="wifi-hide-hint">▶ Masquer</span></span>`;
      el.addEventListener('click', () => connectWifi(n));
      c.appendChild(el);
    });
    updateContentFocus();
  }

  function renderHiddenList() {
    const c = document.getElementById('hiddenNetList');
    if (!c) return;
    c.innerHTML = '';
    if (!hiddenNetworks.length) {
      c.innerHTML = '<div style="color:var(--text-dim);font-family:inherit;font-size:clamp(11px,1.3vw,14px);letter-spacing:2px;text-transform:uppercase;padding:10px 16px">Aucun réseau masqué</div>';
      return;
    }
    const lockSVG     = `<svg width="13" height="15" viewBox="0 0 12 14" fill="none" style="flex-shrink:0;opacity:0.5"><rect x="1" y="6" width="10" height="8" rx="1" fill="none" stroke="rgba(0,164,220,0.6)" stroke-width="1.2"/><path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="rgba(0,164,220,0.6)" stroke-width="1.2"/></svg>`;
    const lockOpenSVG = `<svg width="13" height="15" viewBox="0 0 12 14" fill="none" style="flex-shrink:0;opacity:0.25"><rect x="1" y="6" width="10" height="8" rx="1" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/><path d="M3 6V4a3 3 0 0 1 6 0" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/></svg>`;

    hiddenNetworks.forEach((ssid, i) => {
      const netData  = wifiNetworks.find(n => n.ssid === ssid);
      const el       = document.createElement('div');
      el.className   = 'wifi-network';
      el.dataset.ssid = ssid;
      el.style.opacity = '0.65';

      // Signal + cadenas toujours affichés (barres vides si non détecté)
      const sig = netData ? parseInt(netData.signal || 0) : 0;
      const lit = netData ? (sig > 75 ? 4 : sig > 50 ? 3 : sig > 25 ? 2 : 1) : 0;
      const bars = [1,2,3,4].map(b => `<span class="bar${b <= lit ? ' lit' : ''}"></span>`).join('');
      const isSecure = netData ? (netData.security && netData.security.trim() && netData.security !== 'Open') : false;

      el.innerHTML =
        `<span class="wifi-ssid" style="color:var(--text-dim)">${ssid}</span>` +
        `<span class="wifi-meta">` +
        `<span class="wifi-signal">${bars}</span>` +
        (isSecure ? lockSVG : lockOpenSVG) +
        `<span class="wifi-hide-hint">▶ Démasquer</span></span>`;

      el.addEventListener('click', () => {
        hiddenNetworks.splice(hiddenNetworks.indexOf(ssid), 1);
        saveHiddenNetworks();
        renderHiddenList();
        renderWifiList();
        _updateScanStatus();
      });
      c.appendChild(el);
    });
  }

  /* ─────────────────────────────────────────────────────────────
     SCAN + CONNEXION
  ───────────────────────────────────────────────────────────── */
  function loadCurrentSsid() {
    if (!window.xeLauncher) return;
    window.xeLauncher.wifiCurrentSSID().then(ssid => { wifiCurrentSSID = ssid || ''; });
  }

  function doWifiScan() {
    if (!window.xeLauncher) { if (typeof toast !== 'undefined' && toast) toast.show('API non disponible', true); return; }
    const scanEl = document.getElementById('wifiScanStatus');
    if (scanEl) scanEl.textContent = '…';
    Promise.all([
      window.xeLauncher.wifiCurrentSSID(),
      window.xeLauncher.wifiScan()
    ]).then(([ssid, nets]) => {
      wifiCurrentSSID = ssid || '';
      wifiNetworks    = nets || [];
      _updateScanStatus();
      renderWifiList();
      // Mettre à jour les réseaux masqués avec les nouvelles données signal
      if (hiddenListExpanded) renderHiddenList();
    });
  }

  function connectWifi(net) {
    if (!window.xeLauncher) return;
    if (net.ssid === wifiCurrentSSID) { if (typeof toast !== 'undefined' && toast) toast.show('Déjà connecté', false); return; }
    if (net.security && net.security.trim() && net.security !== 'Open') {
      if (typeof openKb === 'function') {
        openKb('Mot de passe : ' + net.ssid, '', (pwd) => { doWifiConnect(net.ssid, pwd); });
      }
    } else {
      doWifiConnect(net.ssid, '');
    }
  }

  function doWifiConnect(ssid, pwd) {
    if (!window.xeLauncher) return;
    const loadingText = document.getElementById('loadingText');
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingText) loadingText.textContent = 'Connexion à ' + ssid + '…';
    if (loadingOverlay) loadingOverlay.classList.add('visible');
    window.xeLauncher.wifiConnect(ssid, pwd).then(ok => {
      if (loadingOverlay) loadingOverlay.classList.remove('visible');
      if (ok) { wifiCurrentSSID = ssid; if (typeof toast !== 'undefined' && toast) toast.show('Connecté à ' + ssid, false); renderWifiList(); }
      else if (typeof toast !== 'undefined' && toast) toast.show('Connexion échouée', true);
    });
  }

  /* ─────────────────────────────────────────────────────────────
     INTERFACES RÉSEAU
  ───────────────────────────────────────────────────────────── */
  function loadInterfaces() {
    if (!window.xeLauncher) return;
    window.xeLauncher.getInterfaces().then(ifaces => { ifaceList = ifaces || []; renderIfaceList(); });
  }

  function startIfacePolling() {
    stopIfacePolling();
    ifacePollingTimer = setInterval(() => {
      if (typeof activeTab !== 'undefined' && activeTab !== 'network') return;
      if (typeof screen !== 'undefined' && screen !== 'main') return;
      if (!window.xeLauncher) return;
      window.xeLauncher.getInterfaces().then(ifaces => {
        if (!ifaces) return;
        ifaceList = ifaces;
        renderIfaceList();
      });
      window.xeLauncher.wifiCurrentSSID().then(ssid => { if (ssid !== undefined) wifiCurrentSSID = ssid || ''; });
    }, 5000);
  }

  function stopIfacePolling() {
    if (ifacePollingTimer) { clearInterval(ifacePollingTimer); ifacePollingTimer = null; }
  }

  function renderIfaceList() {
    const c = document.getElementById('ifaceList');
    if (!c) return;
    c.innerHTML = '';
    ifaceList.forEach((iface, idx) => {
      const el = document.createElement('div');
      el.className = 'iface-item';
      // Passerelle : utiliser gateway (pas gw) et traiter le cas null/undefined
      const gwDisplay = iface.gateway && iface.gateway !== 'null' && iface.gateway !== null ? iface.gateway : '—';
      el.innerHTML =
        `<div class="iface-dot ${iface.state || 'down'}"></div>` +
        `<span class="iface-name">${iface.name}</span>` +
        `<span class="iface-ip">${iface.ip || '—'}</span>` +
        (iface.gateway && iface.gateway !== 'null' && iface.gateway !== null
          ? `<span style="font-size:clamp(10px,1vw,12px);color:var(--text-hint);margin-left:8px">GW:${gwDisplay}</span>` : '');
      el.addEventListener('click', () => openIfaceOverlay(idx));
      c.appendChild(el);
    });
    if (typeof updateContentFocus === 'function') updateContentFocus();
  }

  /* ─────────────────────────────────────────────────────────────
     OVERLAY CONFIGURATION INTERFACE
  ───────────────────────────────────────────────────────────── */
  function openIfaceOverlay(idx) {
    const iface = ifaceList[idx];
    if (!iface) return;
    stopIfacePolling();
    ifaceOverlayActive = true;
    ifaceOverlayIdx    = idx;
    ifaceOverlayRowIdx = 0;
    if (!ifaceConfigState[iface.name]) {
      const dnsVal = Array.isArray(iface.dns) ? iface.dns[0] || '' : (iface.dns || '');
      // Utiliser iface.gateway (la vraie clé retournée par ipc-network.js)
      const gwVal = (iface.gateway && iface.gateway !== 'null') ? iface.gateway : '';
      ifaceConfigState[iface.name] = { ip: iface.ip || '', mask: iface.mask || '255.255.255.0', gw: gwVal, dns: dnsVal, dhcp: false };
    } else {
      const ex = ifaceConfigState[iface.name];
      if (!ex.gw  && iface.gateway && iface.gateway !== 'null') ex.gw  = iface.gateway;
      if (!ex.dns && iface.dns)     ex.dns = Array.isArray(iface.dns) ? iface.dns[0] || '' : (iface.dns || '');
    }
    if (typeof screen !== 'undefined') screen = 'iface';
    renderIfaceOverlay();
    document.getElementById('ifaceOverlay').classList.add('visible');
  }

  function closeIfaceOverlay() {
    ifaceOverlayActive = false;
    ifaceOverlayIdx    = -1;
    if (typeof screen !== 'undefined') screen = 'main';
    document.getElementById('ifaceOverlay').classList.remove('visible');
    loadInterfaces();
    if (typeof activeTab !== 'undefined' && activeTab === 'network') startIfacePolling();
    if (typeof updateContentFocus === 'function') updateContentFocus();
  }

  function getIfaceOverlayRows() {
    const iface = ifaceList[ifaceOverlayIdx];
    if (!iface) return IFACE_FIELDS;
    const cfg = ifaceConfigState[iface.name];
    return IFACE_FIELDS.filter(f => !(cfg.dhcp && ['ip','mask'].includes(f.key)));
  }

  function renderIfaceOverlay() {
    const iface = ifaceList[ifaceOverlayIdx];
    if (!iface) return;
    const cfg  = ifaceConfigState[iface.name];
    const rows = getIfaceOverlayRows();
    const overlay = document.getElementById('ifaceOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'iface-overlay-title';
    title.innerHTML =
      `<div class="iface-dot ${iface.state || 'down'}" style="margin-right:10px"></div>${iface.name}` +
      `<span style="color:rgba(0,164,220,0.5);font-size:clamp(11px,1.2vw,14px);margin-left:16px">${iface.ip || '—'}</span>`;
    overlay.appendChild(title);

    const hint = document.createElement('div');
    hint.className   = 'iface-overlay-hint';
    hint.textContent = cfg.dhcp ? '◀ ▶  Basculer Statique / DHCP' : '◀ ▶  Basculer  •  Entrée  Éditer  •  Retour  Fermer';
    overlay.appendChild(hint);

    rows.forEach((field, i) => {
      const row = document.createElement('div');
      row.className  = 'iface-overlay-row' + (i === ifaceOverlayRowIdx ? ' focused' : '');
      row.dataset.field = field.key;
      const label = document.createElement('span');
      label.className   = 'iface-overlay-label';
      label.textContent = field.label;
      row.appendChild(label);
      const val = document.createElement('span');
      val.className = 'iface-overlay-value';
      if (field.type === 'toggle') {
        val.innerHTML = `<span class="iface-mode-chip${!cfg.dhcp ? ' active' : ''}">Statique</span><span style="color:var(--text-hint);margin:0 6px">◀▶</span><span class="iface-mode-chip${cfg.dhcp ? ' active' : ''}">DHCP</span>`;
      } else if (field.key === 'apply') {
        row.style.display = 'none';
      } else if (field.key === 'cancel') {
        row.style.display = 'none';
        const applyIdx  = rows.findIndex(f => f.key === 'apply');
        const cancelIdx = rows.findIndex(f => f.key === 'cancel');
        const splitRow  = document.createElement('div');
        splitRow.className = 'iface-overlay-split-row';
        splitRow.innerHTML =
          `<div class="iface-split-btn${ifaceOverlayRowIdx === applyIdx  ? ' focused' : ''}" data-action="apply">✓ Appliquer</div>` +
          `<div class="iface-split-btn iface-split-cancel${ifaceOverlayRowIdx === cancelIdx ? ' focused' : ''}" data-action="cancel">✕ Annuler</div>`;
        overlay.appendChild(splitRow);
        return;
      } else {
        const isDhcpReadonly = cfg.dhcp && ['gw','dns'].includes(field.key);
        if (isDhcpReadonly) {
          let dv = cfg[field.key];
          if (!dv) dv = field.key === 'gw'
            ? ((iface.gateway && iface.gateway !== 'null') ? iface.gateway : '')
            : (Array.isArray(iface.dns) ? iface.dns[0] || '' : (iface.dns || ''));
          val.textContent = dv || '—';
          val.style.opacity = '0.45';
          row.style.cursor = 'default';
          row.style.pointerEvents = 'none';
        } else {
          val.textContent = cfg[field.key] || '—';
        }
      }
      row.appendChild(val);
      overlay.appendChild(row);
    });
  }

  function ifaceOverlayKey(key) {
    const iface = ifaceList[ifaceOverlayIdx];
    if (!iface) return;
    const cfg  = ifaceConfigState[iface.name];
    const rows = getIfaceOverlayRows();
    const currentField = rows[ifaceOverlayRowIdx];
    const applyIdx  = rows.findIndex(f => f.key === 'apply');
    const cancelIdx = rows.findIndex(f => f.key === 'cancel');
    const modeIdx   = rows.findIndex(f => f.key === 'mode');
    const dnsIdx    = rows.findIndex(f => f.key === 'dns');

    if (key === 'ArrowUp') {
      if (ifaceOverlayRowIdx === modeIdx) { ifaceOverlayRowIdx = applyIdx; renderIfaceOverlay(); return; }
      if (ifaceOverlayRowIdx === cancelIdx) { ifaceOverlayRowIdx = dnsIdx !== -1 ? dnsIdx : Math.max(0, applyIdx - 1); renderIfaceOverlay(); return; }
      let next = ifaceOverlayRowIdx - 1;
      if (next === applyIdx) next--;
      ifaceOverlayRowIdx = Math.max(0, next);
      renderIfaceOverlay();
    } else if (key === 'ArrowDown') {
      if (ifaceOverlayRowIdx === applyIdx || ifaceOverlayRowIdx === cancelIdx) { ifaceOverlayRowIdx = modeIdx !== -1 ? modeIdx : 0; renderIfaceOverlay(); return; }
      let next = ifaceOverlayRowIdx + 1;
      if (next === applyIdx) next++;
      if (next >= rows.length) return;
      ifaceOverlayRowIdx = next;
      renderIfaceOverlay();
    } else if (key === 'ArrowRight' && currentField?.key === 'apply') {
      ifaceOverlayRowIdx = cancelIdx; renderIfaceOverlay();
    } else if (key === 'ArrowLeft' && currentField?.key === 'cancel') {
      ifaceOverlayRowIdx = applyIdx; renderIfaceOverlay();
    } else if ((key === 'ArrowLeft' || key === 'ArrowRight') && currentField?.type === 'toggle') {
      cfg.dhcp = !cfg.dhcp; ifaceOverlayRowIdx = 0; renderIfaceOverlay();
    } else if (key === 'Enter') {
      if (currentField?.key === 'apply') { applyIfaceConfig(iface.name); }
      else if (currentField?.key === 'cancel') { delete ifaceConfigState[iface.name]; closeIfaceOverlay(); }
      else if (currentField?.type === 'text') {
        const labels = { ip: 'Adresse IP', mask: 'Masque', gw: 'Passerelle', dns: 'DNS' };
        if (typeof openKbNum === 'function') {
          openKbNum(labels[currentField.key] + ' — ' + iface.name, cfg[currentField.key] || '', (val, ctx) => {
            if (!ifaceConfigState[ctx.iface]) ifaceConfigState[ctx.iface] = {};
            ifaceConfigState[ctx.iface][ctx.field] = val;
          }, { iface: iface.name, field: currentField.key });
        }
      }
    } else if (key === 'Escape' || key === 'Backspace' || key === 'Back') {
      closeIfaceOverlay();
    }
  }

  function applyIfaceConfig(ifaceName) {
    const cfg = ifaceConfigState[ifaceName];
    if (!cfg) return;
    if (!cfg.dhcp && !cfg.ip) { if (typeof toast !== 'undefined' && toast) toast.show('IP manquante', true); return; }
    if (!window.xeLauncher)   { if (typeof toast !== 'undefined' && toast) toast.show('API non disponible', true); return; }
    closeIfaceOverlay();
    const loadingText = document.getElementById('loadingText');
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingText) loadingText.textContent = 'Configuration ' + ifaceName + '…';
    if (loadingOverlay) loadingOverlay.classList.add('visible');
    window.xeLauncher.setStaticIp({ iface: ifaceName, dhcp: cfg.dhcp || false, ip: cfg.ip, mask: cfg.mask || '255.255.255.0', gateway: cfg.gw || '', dns: cfg.dns || '' })
      .then(ok => {
        if (loadingOverlay) loadingOverlay.classList.remove('visible');
        if (typeof toast !== 'undefined' && toast) toast.show(ok ? '✓ Configuration appliquée — ' + ifaceName : '✗ Erreur lors de la configuration', !ok, ok ? 3500 : 5000);
        if (ok) loadInterfaces();
      });
  }

  /* ── API publique ── */
  return {
    get wifiNetworks()    { return wifiNetworks; },
    get wifiCurrentSSID() { return wifiCurrentSSID; },
    get ifaceList()       { return ifaceList; },

    loadHiddenNetworks, saveHiddenNetworks, toggleHiddenList, toggleNetworkVisibility,
    loadKnownNetworks, openKnownOverlay, closeKnownOverlay, renderKnownOverlay, knownOverlayKey,
    renderWifiList, renderHiddenList, doWifiScan, connectWifi, doWifiConnect,
    loadCurrentSsid, loadInterfaces, startIfacePolling, stopIfacePolling, renderIfaceList,
    openIfaceOverlay, closeIfaceOverlay, renderIfaceOverlay, ifaceOverlayKey, applyIfaceConfig,
  };
})();
