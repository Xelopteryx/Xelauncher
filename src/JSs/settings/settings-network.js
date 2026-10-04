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
 *
 * Overlay d'interface (IPv4 uniquement) :
 * - Masque affiché "255.255.255.0 (/24)" ; saisie possible en CIDR seul ("24", "/24")
 * - DNS principal + DNS secondaire
 * - En DHCP : IP, masque, passerelle et DNS réels affichés (lecture seule)
 * - Adresse MAC affichée en bas à gauche tant que l'overlay est ouvert
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
  let hiddenOverlayActive   = false;
  let hiddenOverlayFocusIdx = 0;
  let knownNetworks   = [];
  let knownOverlayActive  = false;
  let knownOverlayFocusIdx = 0;
  let knownOverlayColIdx   = 0;
  let knownReorderMode = false;
  let knownReorderIdx  = -1;
  let ifaceOverlayActive = false;
  let ifaceOverlayIdx    = -1;
  let ifaceOverlayRowIdx = 0;
  /* Choix DHCP/Statique en cours de survol (◀ ▶) mais pas encore validé —
     null = pas de survol actif, on affiche cfg.dhcp tel quel. Entrée
     valide ce choix dans cfg.dhcp ; ça ne doit plus basculer d'un coup
     sur simple Gauche/Droite. */
  let ifaceModeChoice    = null;
  /* Message d'erreur affiché DANS l'overlay (les toasts passent derrière :
     z-index 600 < 700), effacé à la prochaine touche. */
  let ifaceMessage       = null;
  let ifacePollingTimer  = null;
  let _backgroundScanTimer = null;  // scan périodique en arrière-plan pour overlay connus

  const IFACE_FIELDS = [
    { key: 'mode',   label: 'Mode',           type: 'toggle' },
    { key: 'ip',     label: 'Adresse IP',     type: 'text'   },
    { key: 'mask',   label: 'Masque',         type: 'text'   },
    { key: 'gw',     label: 'Passerelle',     type: 'text'   },
    { key: 'dns',    label: 'DNS principal',  type: 'text'   },
    { key: 'dns2',   label: 'DNS secondaire', type: 'text'   },
    { key: 'apply',  label: 'Appliquer',      type: 'action' },
    { key: 'cancel', label: 'Annuler',        type: 'action' },
  ];

  /* ─────────────────────────────────────────────────────────────
     MASQUE RÉSEAU ⇄ CIDR
  ───────────────────────────────────────────────────────────── */
  /** 24 → "255.255.255.0" ; null si hors de 0-32. */
  function _cidrToMask(n) {
    n = parseInt(n, 10);
    if (isNaN(n) || n < 0 || n > 32) return null;
    const bits = n === 0 ? 0 : (0xFFFFFFFF << (32 - n)) >>> 0;
    return [24, 16, 8, 0].map(s => (bits >>> s) & 255).join('.');
  }

  /** "255.255.255.0" → 24 ; null si le masque est invalide (bits non contigus, etc.). */
  function _maskToCidr(mask) {
    const parts = (mask || '').split('.');
    if (parts.length !== 4) return null;
    let bits = 0, seenZero = false;
    for (const o of parts) {
      if (!/^\d{1,3}$/.test(o)) return null;
      const v = parseInt(o, 10);
      if (v > 255) return null;
      for (let b = 7; b >= 0; b--) {
        if ((v >> b) & 1) { if (seenZero) return null; bits++; }
        else seenZero = true;
      }
    }
    return bits;
  }

  /** Accepte "24", "/24" ou "255.255.255.0" ; renvoie le masque pointé, ou null si invalide. */
  function _normalizeMask(input) {
    const s = (input || '').trim().replace(/^\//, '');
    if (/^\d{1,2}$/.test(s)) return _cidrToMask(s);
    return _maskToCidr(s) !== null ? s : null;
  }

  /** Valeurs réellement actives sur l'interface (telles que lues par le backend). */
  function _liveValues(iface) {
    const dnsArr = Array.isArray(iface.dns) ? iface.dns : (iface.dns ? [iface.dns] : []);
    return {
      ip:   iface.ip || '',
      mask: iface.cidr ? (_cidrToMask(iface.cidr) || '') : '',
      gw:   (iface.gateway && iface.gateway !== 'null') ? iface.gateway : '',
      dns:  dnsArr[0] || '',
      dns2: dnsArr[1] || '',
    };
  }

  /* ── Dernière configuration STATIQUE utilisée, par interface (localStorage) ──
     Sert à pré-remplir les champs quand on repasse de DHCP à Statique. */
  const STATIC_STORE_KEY = 'xelauncher_static_ip';

  function _loadSavedStatic(name) {
    try { return (JSON.parse(localStorage.getItem(STATIC_STORE_KEY) || '{}'))[name] || null; }
    catch (e) { return null; }
  }

  function _saveStatic(name, cfg) {
    if (!cfg || !cfg.ip) return;
    try {
      const all = JSON.parse(localStorage.getItem(STATIC_STORE_KEY) || '{}');
      all[name] = { ip: cfg.ip, mask: cfg.mask, gw: cfg.gw, dns: cfg.dns, dns2: cfg.dns2 };
      localStorage.setItem(STATIC_STORE_KEY, JSON.stringify(all));
    } catch (e) {}
  }

  function _isValidIPv4(s) {
    const p = (s || '').split('.');
    return p.length === 4 && p.every(o => /^\d{1,3}$/.test(o) && parseInt(o, 10) <= 255);
  }

  /* ── Compteur visible ── */
  function _visibleCount() {
    const knownSSIDs = new Set(knownNetworks.map(n => n.ssid));
    return wifiNetworks.filter(n => !hiddenNetworks.includes(n.ssid) && !knownSSIDs.has(n.ssid)).length;
  }

  function _updateScanStatus() {
    const el = document.getElementById('wifiScanStatus');
    if (!el) return;
    const count = _visibleCount();
    if (wifiNetworks.length === 0) { el.textContent = '\u21bb'; return; }
    el.textContent = count === 0 ? '0 r\u00e9seau' : count === 1 ? '1 r\u00e9seau' : count + ' r\u00e9seaux';
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

  function openHiddenOverlay() {
    hiddenOverlayActive   = true;
    hiddenOverlayFocusIdx = 0;
    if (typeof screen !== 'undefined') screen = 'hiddenOverlay';
    document.getElementById('hiddenOverlay').classList.add('visible');
    renderHiddenOverlay();
  }

  function closeHiddenOverlay() {
    hiddenOverlayActive = false;
    if (typeof screen !== 'undefined') screen = 'main';
    document.getElementById('hiddenOverlay').classList.remove('visible');
    if (typeof updateContentFocus === 'function') updateContentFocus();
  }

  /** Masquer un réseau depuis la liste WiFi principale (flèche droite dessus). */
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
    if (el) el.textContent = knownNetworks.length ? knownNetworks.length + '' : '\u2014';
  }

  function saveKnownNetworksPriority() {
    if (!window.xeLauncher) return;
    window.xeLauncher.setKnownNetworksPriority(knownNetworks.map(n => n.ssid))
      .then(ok => { if (!ok && typeof toast !== 'undefined' && toast) toast.show('Erreur sauvegarde priorit\u00e9s', true); });
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
    title.textContent = 'R\u00e9seaux connus';
    overlay.appendChild(title);

    const hint = document.createElement('div');
    hint.className   = 'iface-overlay-hint';
    hint.textContent = knownReorderMode
      ? '\u2191 \u2193  D\u00e9placer  \u2022  Entr\u00e9e  Valider  \u2022  Retour  Annuler'
      : '\u2191 \u2193  Naviguer  \u2022  Entr\u00e9e  Connecter/D\u00e9connecter  \u2022  \u2192  Autres actions  \u2022  Retour  Fermer';
    overlay.appendChild(hint);

    if (!knownNetworks.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim);font-family:inherit;font-size:clamp(12px,1.4vw,16px);letter-spacing:2px;text-transform:uppercase;padding:20px 0';
      empty.textContent = 'Aucun r\u00e9seau enregistr\u00e9';
      overlay.appendChild(empty);
      const closeBtn = document.createElement('div');
      closeBtn.className = 'known-overlay-row' + (knownOverlayFocusIdx === 0 ? ' focused' : '');
      closeBtn.style.cssText = 'justify-content:center;margin-top:16px';
      closeBtn.textContent = '\u2190 Fermer';
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
      /* Le nom du réseau EST le bouton connecter/déconnecter — plus de
         bouton séparé : cliquer ici tente une connexion (sauf réseau hors
         de portée) ou déconnecte si c'est déjà celui-ci. */
      left.classList.toggle('known-focused-action', isFocused && knownOverlayColIdx === 0);
      left.addEventListener('click', () => {
        if (isCurrent) { doKnownDisconnect(); return; }
        if (!isAvail) { if (typeof toast !== 'undefined' && toast) toast.show('R\u00e9seau hors de port\u00e9e', true); return; }
        doKnownConnect(net);
      });

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
        cs.textContent = '\u25cf connect\u00e9';
        left.appendChild(cs);
      }
      row.appendChild(left);

      // Actions (seulement si pas en mode réordonnancement)
      const actions = document.createElement('div');
      actions.className = 'known-overlay-actions';

      if (!knownReorderMode) {
        const colFocus = isFocused ? knownOverlayColIdx : -1;

        // Bouton Supprimer
        const forgetBtn = document.createElement('div');
        forgetBtn.className   = 'known-prio-btn option-item known-forget-btn' + (colFocus === 1 ? ' focused' : '');
        forgetBtn.textContent = '\u2715';
        forgetBtn.title       = 'Supprimer';
        forgetBtn.addEventListener('click', () => doKnownForget(i));
        actions.appendChild(forgetBtn);

        // Bouton monter
        const upBtn = document.createElement('div');
        upBtn.className   = 'known-prio-btn option-item' + (i === 0 ? ' disabled' : '') + (colFocus === 2 ? ' focused' : '');
        upBtn.textContent = '\u2191';
        upBtn.title       = 'Monter';
        if (i > 0) upBtn.addEventListener('click', () => { moveKnownNet(i, -1); knownOverlayFocusIdx--; saveKnownNetworksPriority(); renderKnownOverlay(); });
        actions.appendChild(upBtn);

        // Bouton descendre
        const downBtn = document.createElement('div');
        downBtn.className   = 'known-prio-btn option-item' + (i === knownNetworks.length - 1 ? ' disabled' : '') + (colFocus === 3 ? ' focused' : '');
        downBtn.textContent = '\u2193';
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
    closeRow.textContent = '\u2190 Fermer';
    closeRow.addEventListener('click', closeKnownOverlay);
    overlay.appendChild(closeRow);

    // Le scroll ne suit pas la navigation clavier/manette tout seul —
    // amener la ligne focalisée dans la zone visible à chaque rendu.
    const _focusedEl = overlay.querySelector('.focused');
    if (_focusedEl) _focusedEl.scrollIntoView({ block: 'nearest' });
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
    else if (key === 'ArrowRight' && onNetRow) { knownOverlayColIdx = Math.min(3, knownOverlayColIdx + 1); renderKnownOverlay(); }
    else if (key === 'ArrowLeft') { if (knownOverlayColIdx > 0) { knownOverlayColIdx--; renderKnownOverlay(); } }
    else if (key === 'Enter') {
      if (knownOverlayFocusIdx === total) { closeKnownOverlay(); return; }
      const net = knownNetworks[knownOverlayFocusIdx];
      if (!net) return;
      const i = knownOverlayFocusIdx;
      const isCurrent = net.ssid === wifiCurrentSSID;
      const isAvail   = new Set(wifiNetworks.map(n => n.ssid)).has(net.ssid);
      if (knownOverlayColIdx === 0) {
        /* Colonne 0 = la ligne elle-même : connecter/déconnecter directement,
           plus besoin d'un pas intermédiaire "→ Actions". */
        if (isCurrent) doKnownDisconnect();
        else if (!isAvail) { if (typeof toast !== 'undefined' && toast) toast.show('R\u00e9seau hors de port\u00e9e', true); }
        else doKnownConnect(net);
      }
      else if (knownOverlayColIdx === 1) { doKnownForget(i); }
      else if (knownOverlayColIdx === 2 && i > 0) { moveKnownNet(i, -1); knownOverlayFocusIdx--; saveKnownNetworksPriority(); renderKnownOverlay(); }
      else if (knownOverlayColIdx === 3 && i < knownNetworks.length - 1) { moveKnownNet(i, 1); knownOverlayFocusIdx++; saveKnownNetworksPriority(); renderKnownOverlay(); }
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
      if (ok) { wifiCurrentSSID = ''; if (typeof toast !== 'undefined' && toast) toast.show('D\u00e9connect\u00e9', false); renderWifiList(); }
      else if (typeof toast !== 'undefined' && toast) toast.show('Erreur d\u00e9connexion', true);
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
        if (typeof toast !== 'undefined' && toast) toast.show('R\u00e9seau oubli\u00e9', false);
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
      c.innerHTML = '<div style="color:var(--text-dim);font-family:inherit;font-size:clamp(11px,1.3vw,14px);letter-spacing:2px;text-transform:uppercase;padding:12px 16px">Aucun r\u00e9seau \u2014 lancez un scan</div>';
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
        (n.ssid === wifiCurrentSSID ? '<span style="color:#a5d6a7;font-size:13px;margin-right:4px">\u2713</span>' : '') +
        (isSecure ? lockSVG : lockOpenSVG) +
        `<span class="wifi-hide-hint">\u25b6 Masquer</span></span>`;
      el.addEventListener('click', () => connectWifi(n));
      c.appendChild(el);
    });
    updateContentFocus();
  }

  function renderHiddenOverlay() {
    const overlay = document.getElementById('hiddenOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';

    const title = document.createElement('div');
    title.className   = 'iface-overlay-title';
    title.textContent = 'R\u00e9seaux masqu\u00e9s';
    overlay.appendChild(title);

    const hint = document.createElement('div');
    hint.className   = 'iface-overlay-hint';
    hint.textContent = '\u2191 \u2193  Naviguer  \u2022  Entr\u00e9e  D\u00e9masquer  \u2022  Retour  Fermer';
    overlay.appendChild(hint);

    if (!hiddenNetworks.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--text-dim);font-family:inherit;font-size:clamp(12px,1.4vw,16px);letter-spacing:2px;text-transform:uppercase;padding:20px 0';
      empty.textContent = 'Aucun r\u00e9seau masqu\u00e9';
      overlay.appendChild(empty);
      const closeBtn = document.createElement('div');
      closeBtn.className = 'known-overlay-row focused';
      closeBtn.style.cssText = 'justify-content:center;margin-top:16px';
      closeBtn.textContent = '\u2190 Fermer';
      closeBtn.addEventListener('click', closeHiddenOverlay);
      overlay.appendChild(closeBtn);
      return;
    }

    const lockSVG     = `<svg width="13" height="15" viewBox="0 0 12 14" fill="none" style="flex-shrink:0;margin-right:4px;opacity:0.5"><rect x="1" y="6" width="10" height="8" rx="1" fill="none" stroke="rgba(0,164,220,0.6)" stroke-width="1.2"/><path d="M3 6V4a3 3 0 0 1 6 0v2" fill="none" stroke="rgba(0,164,220,0.6)" stroke-width="1.2"/></svg>`;
    const lockOpenSVG = `<svg width="13" height="15" viewBox="0 0 12 14" fill="none" style="flex-shrink:0;margin-right:4px;opacity:0.25"><rect x="1" y="6" width="10" height="8" rx="1" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/><path d="M3 6V4a3 3 0 0 1 6 0" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="1.2"/></svg>`;

    hiddenNetworks.forEach((ssid, i) => {
      const netData   = wifiNetworks.find(n => n.ssid === ssid);
      const isFocused = hiddenOverlayFocusIdx === i;
      const sig       = netData ? parseInt(netData.signal || 0) : 0;
      const lit       = netData ? (sig > 75 ? 4 : sig > 50 ? 3 : sig > 25 ? 2 : 1) : 0;
      const isSecure  = netData ? (netData.security && netData.security.trim() && netData.security !== 'Open') : false;
      const bars      = [1,2,3,4].map(b => `<span class="bar${b <= lit ? ' lit' : ''}"></span>`).join('');

      const row = document.createElement('div');
      row.className = 'known-overlay-row' + (isFocused ? ' focused' : '');

      const left = document.createElement('div');
      left.className = 'known-overlay-left';
      left.innerHTML =
        `<span class="wifi-signal" style="margin-right:6px">${bars}</span>` +
        (isSecure ? lockSVG : lockOpenSVG) +
        `<span class="known-overlay-ssid" style="opacity:0.6">${ssid}</span>`;
      row.appendChild(left);

      const hintSpan = document.createElement('span');
      hintSpan.style.cssText = 'font-size:var(--fs-hint);letter-spacing:1px;color:rgba(0,164,220,0.6);text-transform:uppercase;flex-shrink:0';
      hintSpan.textContent = '\u2192 d\u00e9masquer';
      row.appendChild(hintSpan);

      row.addEventListener('click', () => {
        hiddenNetworks.splice(hiddenNetworks.indexOf(ssid), 1);
        saveHiddenNetworks();
        renderWifiList();
        _updateScanStatus();
        if (hiddenOverlayFocusIdx >= hiddenNetworks.length) hiddenOverlayFocusIdx = Math.max(0, hiddenNetworks.length - 1);
        renderHiddenOverlay();
      });
      overlay.appendChild(row);
    });

    const closeRow = document.createElement('div');
    const isCloseFocused = hiddenOverlayFocusIdx === hiddenNetworks.length;
    closeRow.className = 'known-overlay-row' + (isCloseFocused ? ' focused' : '');
    closeRow.style.cssText = 'justify-content:center;margin-top:8px;opacity:0.7';
    closeRow.textContent = '\u2190 Fermer';
    closeRow.addEventListener('click', closeHiddenOverlay);
    overlay.appendChild(closeRow);

    const _focusedEl = overlay.querySelector('.focused');
    if (_focusedEl) _focusedEl.scrollIntoView({ block: 'nearest' });
  }

  function hiddenOverlayKey(key) {
    const total = hiddenNetworks.length;
    if (key === 'ArrowUp')   { hiddenOverlayFocusIdx = Math.max(0, hiddenOverlayFocusIdx - 1); renderHiddenOverlay(); }
    else if (key === 'ArrowDown') { hiddenOverlayFocusIdx = Math.min(total, hiddenOverlayFocusIdx + 1); renderHiddenOverlay(); }
    else if (key === 'Enter') {
      if (hiddenOverlayFocusIdx === total) { closeHiddenOverlay(); return; }
      const ssid = hiddenNetworks[hiddenOverlayFocusIdx];
      if (!ssid) return;
      hiddenNetworks.splice(hiddenOverlayFocusIdx, 1);
      saveHiddenNetworks();
      renderWifiList();
      _updateScanStatus();
      if (hiddenOverlayFocusIdx >= hiddenNetworks.length) hiddenOverlayFocusIdx = Math.max(0, hiddenNetworks.length - 1);
      renderHiddenOverlay();
    }
    else if (key === 'Escape' || key === 'Backspace' || key === 'Back') { closeHiddenOverlay(); }
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
    if (scanEl) scanEl.textContent = '\u2026';
    Promise.all([
      window.xeLauncher.wifiCurrentSSID(),
      window.xeLauncher.wifiScan()
    ]).then(([ssid, nets]) => {
      wifiCurrentSSID = ssid || '';
      wifiNetworks    = nets || [];
      _updateScanStatus();
      renderWifiList();
      // Mettre à jour les réseaux masqués avec les nouvelles données signal
      if (hiddenOverlayActive) renderHiddenOverlay();
    });
  }

  function connectWifi(net) {
    if (!window.xeLauncher) return;
    if (net.ssid === wifiCurrentSSID) { if (typeof toast !== 'undefined' && toast) toast.show('D\u00e9j\u00e0 connect\u00e9', false); return; }
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
    if (loadingText) loadingText.textContent = 'Connexion \u00e0 ' + ssid + '\u2026';
    if (loadingOverlay) loadingOverlay.classList.add('visible');
    window.xeLauncher.wifiConnect(ssid, pwd).then(ok => {
      if (loadingOverlay) loadingOverlay.classList.remove('visible');
      if (ok) { wifiCurrentSSID = ssid; if (typeof toast !== 'undefined' && toast) toast.show('Connect\u00e9 \u00e0 ' + ssid, false); renderWifiList(); }
      else if (typeof toast !== 'undefined' && toast) toast.show('Connexion \u00e9chou\u00e9e', true);
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
      el.innerHTML =
        `<div class="iface-dot ${iface.state || 'down'}"></div>` +
        `<span class="iface-name">${iface.name}</span>` +
        `<span class="iface-ip">${iface.ip || '\u2014'}</span>`;
      el.addEventListener('click', () => openIfaceOverlay(idx));
      c.appendChild(el);
    });
    if (typeof updateContentFocus === 'function') updateContentFocus();
  }

  /* ─────────────────────────────────────────────────────────────
     OVERLAY CONFIGURATION INTERFACE (IPv4)
  ───────────────────────────────────────────────────────────── */
  function openIfaceOverlay(idx) {
    const iface = ifaceList[idx];
    if (!iface) return;
    stopIfacePolling();
    ifaceOverlayActive = true;
    ifaceOverlayIdx    = idx;
    ifaceOverlayRowIdx = 0;
    ifaceModeChoice    = null;
    /* Toujours repartir des valeurs RÉELLES actuelles à l'ouverture
       (IP, masque déduit du CIDR détecté, passerelle, DNS 1 et 2). Le mode
       DHCP/Statique reflète la méthode réelle (iface.dhcp, détectée côté
       backend). */
    const live = _liveValues(iface);
    ifaceConfigState[iface.name] = {
      ip:   live.ip,
      mask: live.mask || '255.255.255.0',
      gw:   live.gw,
      dns:  live.dns,
      dns2: live.dns2,
      dhcp: iface.dhcp !== false,
    };
    ifaceMessage = null;
    /* Déjà en statique : ces valeurs sont la config statique en cours, on les retient. */
    if (iface.dhcp === false) _saveStatic(iface.name, ifaceConfigState[iface.name]);
    if (typeof screen !== 'undefined') screen = 'iface';
    renderIfaceOverlay();
    document.getElementById('ifaceOverlay').classList.add('visible');
  }

  function closeIfaceOverlay() {
    ifaceOverlayActive = false;
    ifaceOverlayIdx    = -1;
    ifaceModeChoice    = null;
    if (typeof screen !== 'undefined') screen = 'main';
    document.getElementById('ifaceOverlay').classList.remove('visible');
    loadInterfaces();
    if (typeof activeTab !== 'undefined' && activeTab === 'network') startIfacePolling();
    if (typeof updateContentFocus === 'function') updateContentFocus();
  }

  function getIfaceOverlayRows() {
    return IFACE_FIELDS;
  }

  function renderIfaceOverlay() {
    const iface = ifaceList[ifaceOverlayIdx];
    if (!iface) return;
    const cfg  = ifaceConfigState[iface.name];
    if (!cfg) return;
    const rows = getIfaceOverlayRows();
    const live = _liveValues(iface);
    const overlay = document.getElementById('ifaceOverlay');
    if (!overlay) return;
    overlay.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'iface-overlay-title';
    title.innerHTML =
      `<div class="iface-dot ${iface.state || 'down'}" style="margin-right:10px"></div>${iface.name}` +
      `<span style="color:rgba(0,164,220,0.5);font-size:clamp(11px,1.2vw,14px);margin-left:16px">${iface.ip || '\u2014'}</span>`;
    overlay.appendChild(title);

    const hint = document.createElement('div');
    hint.className   = 'iface-overlay-hint';
    hint.textContent = '\u2191 \u2193  Naviguer  \u2022  \u25c0 \u25b6  Choisir  \u2022  Entr\u00e9e  Valider / \u00c9diter  \u2022  Retour  Fermer';
    overlay.appendChild(hint);

    if (ifaceMessage) {
      const msg = document.createElement('div');
      msg.style.cssText = 'color:#e85555;font-family:var(--font-admin);font-size:var(--fs-small);letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;text-align:center';
      msg.textContent = ifaceMessage;
      overlay.appendChild(msg);
    }

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
        const highlightDhcp = (i === ifaceOverlayRowIdx && ifaceModeChoice !== null) ? ifaceModeChoice : cfg.dhcp;
        val.innerHTML = `<span class="iface-mode-chip${!highlightDhcp ? ' active' : ''}">Statique</span><span style="color:var(--text-hint);margin:0 6px">\u25c0\u25b6</span><span class="iface-mode-chip${highlightDhcp ? ' active' : ''}">DHCP</span>`;
      } else if (field.key === 'apply') {
        row.style.display = 'none';
      } else if (field.key === 'cancel') {
        row.style.display = 'none';
        const applyIdx  = rows.findIndex(f => f.key === 'apply');
        const cancelIdx = rows.findIndex(f => f.key === 'cancel');
        const splitRow  = document.createElement('div');
        splitRow.className = 'iface-overlay-split-row';
        splitRow.innerHTML =
          `<div class="iface-split-btn${ifaceOverlayRowIdx === applyIdx  ? ' focused' : ''}" data-action="apply">\u2713 Appliquer</div>` +
          `<div class="iface-split-btn iface-split-cancel${ifaceOverlayRowIdx === cancelIdx ? ' focused' : ''}" data-action="cancel">\u2715 Annuler</div>`;
        overlay.appendChild(splitRow);
        return;
      } else {
        /* En DHCP : valeurs réellement attribuées, en lecture seule.
           En statique : valeurs éditées. */
        const readonly = cfg.dhcp;
        let dv = readonly ? live[field.key] : cfg[field.key];
        if (field.key === 'mask' && dv) {
          const c = _maskToCidr(dv);
          if (c !== null) dv += ' (/' + c + ')';
        }
        val.textContent = dv || '\u2014';
        if (readonly) {
          val.style.opacity = '0.45';
          row.style.cursor = 'default';
          row.style.pointerEvents = 'none';
        }
      }
      row.appendChild(val);
      overlay.appendChild(row);
    });

    /* Adresse MAC — coin inférieur gauche de l'écran, visible uniquement
       tant que cet overlay est ouvert (il est reconstruit à chaque rendu). */
    if (iface.mac) {
      const macEl = document.createElement('div');
      macEl.className = 'iface-overlay-mac';
      macEl.style.cssText =
        'position:fixed;left:clamp(16px,2.5vw,32px);bottom:clamp(12px,2.5vh,28px);' +
        'font-family:var(--font-admin);font-size:var(--fs-small);letter-spacing:2px;' +
        'text-transform:uppercase;color:var(--text-dim);pointer-events:none';
      macEl.textContent = 'MAC  ' + iface.mac;
      overlay.appendChild(macEl);
    }
  }

  function ifaceOverlayKey(key) {
    const iface = ifaceList[ifaceOverlayIdx];
    if (!iface) return;
    const cfg  = ifaceConfigState[iface.name];
    const rows = getIfaceOverlayRows();
    ifaceMessage = null;
    const currentField = rows[ifaceOverlayRowIdx];
    const applyIdx     = rows.findIndex(f => f.key === 'apply');
    const cancelIdx    = rows.findIndex(f => f.key === 'cancel');
    const modeIdx      = rows.findIndex(f => f.key === 'mode');
    const lastFieldIdx = rows.findIndex(f => f.key === 'dns2');

    if (key === 'ArrowUp') {
      if (ifaceOverlayRowIdx === modeIdx) { ifaceModeChoice = null; ifaceOverlayRowIdx = applyIdx; }
      else if (ifaceOverlayRowIdx === applyIdx || ifaceOverlayRowIdx === cancelIdx) { ifaceOverlayRowIdx = lastFieldIdx; }
      else { ifaceOverlayRowIdx = Math.max(0, ifaceOverlayRowIdx - 1); }
      renderIfaceOverlay();
    } else if (key === 'ArrowDown') {
      if (ifaceOverlayRowIdx === applyIdx || ifaceOverlayRowIdx === cancelIdx) { ifaceOverlayRowIdx = modeIdx; }
      else if (ifaceOverlayRowIdx === lastFieldIdx) { ifaceOverlayRowIdx = applyIdx; }
      else {
        if (ifaceOverlayRowIdx === modeIdx) ifaceModeChoice = null;
        ifaceOverlayRowIdx = ifaceOverlayRowIdx + 1;
      }
      renderIfaceOverlay();
    } else if (key === 'ArrowRight' && currentField?.key === 'apply') {
      ifaceOverlayRowIdx = cancelIdx; renderIfaceOverlay();
    } else if (key === 'ArrowLeft' && currentField?.key === 'cancel') {
      ifaceOverlayRowIdx = applyIdx; renderIfaceOverlay();
    } else if ((key === 'ArrowLeft' || key === 'ArrowRight') && currentField?.type === 'toggle') {
      /* Ne fait que déplacer le survol Statique/DHCP — ne s'applique pas
         tant que Entrée n'a pas validé (voir ci-dessous). */
      if (ifaceModeChoice === null) ifaceModeChoice = cfg.dhcp;
      ifaceModeChoice = !ifaceModeChoice;
      renderIfaceOverlay();
    } else if (key === 'Enter') {
      if (currentField?.key === 'apply') { applyIfaceConfig(iface.name); }
      else if (currentField?.key === 'cancel') { delete ifaceConfigState[iface.name]; closeIfaceOverlay(); }
      else if (currentField?.type === 'toggle') {
        if (ifaceModeChoice !== null && ifaceModeChoice !== cfg.dhcp) {
          const toDhcp = ifaceModeChoice;
          if (toDhcp) {
            /* On garde les valeurs statiques en cours d'édition au cas où on revienne. */
            cfg._staticDraft = { ip: cfg.ip, mask: cfg.mask, gw: cfg.gw, dns: cfg.dns, dns2: cfg.dns2 };
          } else {
            /* Retour en statique : brouillon de cette session, sinon dernière config statique mémorisée. */
            const src = cfg._staticDraft || _loadSavedStatic(iface.name);
            if (src) Object.assign(cfg, src);
          }
          cfg.dhcp = toDhcp;
          ifaceOverlayRowIdx = 0;
        }
        ifaceModeChoice = null;
        renderIfaceOverlay();
      }
      else if (currentField?.type === 'text') {
        if (cfg.dhcp) return; // champs en lecture seule tant qu'on est en DHCP
        const labels = {
          ip: 'Adresse IP', mask: 'Masque', gw: 'Passerelle',
          dns: 'DNS principal', dns2: 'DNS secondaire',
        };
        if (typeof openKbNum === 'function') {
          openKbNum(labels[currentField.key] + ' \u2014 ' + iface.name, cfg[currentField.key] || '', (val, ctx) => {
            const st = ifaceConfigState[ctx.iface];
            if (!st) return;
            let v = (val || '').trim();
            if (ctx.field === 'mask') {
              /* "24", "/24" ou "255.255.255.0" acceptés. */
              const norm = _normalizeMask(v);
              if (!norm) { ifaceMessage = 'Masque invalide (ex: 24 ou 255.255.255.0)'; renderIfaceOverlay(); return; }
              v = norm;
            } else if (v && !_isValidIPv4(v)) {
              ifaceMessage = 'Adresse invalide (ex: 192.168.1.1)'; renderIfaceOverlay(); return;
            }
            st[ctx.field] = v;
            /* closeKbNum() a d\u00e9j\u00e0 redessin\u00e9 l'overlay AVANT ce callback : on redessine pour afficher la valeur saisie. */
            renderIfaceOverlay();
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
    if (!cfg.dhcp && !cfg.ip) { ifaceMessage = 'IP manquante'; renderIfaceOverlay(); return; }
    if (!window.xeLauncher)   { if (typeof toast !== 'undefined' && toast) toast.show('API non disponible', true); return; }
    closeIfaceOverlay();
    const loadingText = document.getElementById('loadingText');
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingText) loadingText.textContent = 'Configuration ' + ifaceName + '\u2026';
    if (loadingOverlay) loadingOverlay.classList.add('visible');
    /* DNS principal + secondaire envoyés ensemble, séparés par un espace
       (format accepté tel quel par nmcli ipv4.dns). */
    const dnsJoined = [cfg.dns, cfg.dns2].filter(Boolean).join(' ');
    window.xeLauncher.setStaticIp({ iface: ifaceName, dhcp: cfg.dhcp || false, ip: cfg.ip, mask: cfg.mask || '255.255.255.0', gateway: cfg.gw || '', dns: dnsJoined })
      .then(ok => {
        if (loadingOverlay) loadingOverlay.classList.remove('visible');
        if (typeof toast !== 'undefined' && toast) toast.show(ok ? '\u2713 Configuration appliqu\u00e9e \u2014 ' + ifaceName : '\u2717 Erreur lors de la configuration', !ok, ok ? 3500 : 5000);
        if (ok) {
          if (!cfg.dhcp) _saveStatic(ifaceName, cfg);
          loadInterfaces();
        }
      });
  }

  /* ── API publique ── */
  return {
    get wifiNetworks()    { return wifiNetworks; },
    get wifiCurrentSSID() { return wifiCurrentSSID; },
    get ifaceList()       { return ifaceList; },

    loadHiddenNetworks, saveHiddenNetworks, openHiddenOverlay, closeHiddenOverlay,
    renderHiddenOverlay, hiddenOverlayKey, toggleNetworkVisibility,
    loadKnownNetworks, openKnownOverlay, closeKnownOverlay, renderKnownOverlay, knownOverlayKey,
    renderWifiList, doWifiScan, connectWifi, doWifiConnect,
    loadCurrentSsid, loadInterfaces, startIfacePolling, stopIfacePolling, renderIfaceList,
    openIfaceOverlay, closeIfaceOverlay, renderIfaceOverlay, ifaceOverlayKey, applyIfaceConfig,
  };
})();
