/**
 * settings-core.js
 * Initialisation, état global, routage des onglets, focus sidebar/contenu,
 * claviers virtuels, et dispatcher principal onKey().
 *
 * Dépendances (chargées avant ce fichier) :
 *   input.js          → XeInput
 *   settings-system.js, settings-display.js, settings-audio.js,
 *   settings-network.js, settings-bluetooth.js,
 *   settings-controllers.js, settings-jellyfin.js
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   INSTANCES PARTAGÉES
═══════════════════════════════════════════════════════════════ */
let toast         = null;
let mapper        = null;
let gpPoller      = null;
let remoteCapture = null;
let kb            = null;
let kbNum         = null;

const REMOTE_DEVICE_ID = '__remote__';

/* ═══════════════════════════════════════════════════════════════
   ÉTAT GLOBAL (partagé par tous les modules settings-*)
═══════════════════════════════════════════════════════════════ */
let inputReady    = false;
let activeTab     = 'system';
const TABS        = ['system','display','audio','network','bluetooth','controllers','jellyfin'];

let rowFocusMap   = {};
TABS.forEach(t => { rowFocusMap[t] = 0; });

let sidebarFocused  = false;
let sidebarFocusIdx = 0;
let screen          = 'main';

/* ── Dropdown actif ── */
let activeDropdown = null;

/* ── Mapper inline ── */
let mapperActive      = false;
let mapperDeviceId    = '';
let mapperCurrentIdx  = 0;
let mapperResult      = {};
let mapperWaiting     = false;

/* ── Clavier ── */
let kbCallback    = null;
let kbContextData = null;
let kbPrevScreen  = 'main';

/* ═══════════════════════════════════════════════════════════════
   CLAVIERS VIRTUELS
═══════════════════════════════════════════════════════════════ */
/* kb and kbNum initialized in initSettings() after XeInput loads */

function openKb(label, initial, callback, contextData) {
  kbPrevScreen = screen;
  document.getElementById('kbLabel').textContent = label;
  kb.open(initial || '');
  kbCallback    = callback;
  kbContextData = contextData || null;
  kb.onConfirm  = (val) => { closeKb(); if (kbCallback) kbCallback(val, kbContextData); };
  kb.onCancel   = closeKb;
  document.getElementById('kbOverlay').classList.add('visible');
  screen = 'kb';
}

function closeKb() {
  document.getElementById('kbOverlay').classList.remove('visible');
  screen = kbPrevScreen;
  if (screen === 'iface') XeSettings.Network.renderIfaceOverlay();
}

function openKbNum(label, initial, callback, contextData) {
  kbPrevScreen = screen;
  document.getElementById('kbNumLabel').textContent = label;
  kbNum.open(initial || '');
  /* kbNum.setMode('nums') supprimé : keyboard.js ne sépare plus les modes
     lettres/chiffres depuis sa réécriture (grille unique, chiffres déjà
     sur la 1ère rangée) — cette méthode n'existe plus et faisait planter
     toute la fonction avant même que l'overlay ne devienne visible.
     C'est la cause du "impossible de modifier les champs en mode
     Statique" : le clavier ne s'ouvrait tout simplement jamais. */
  kbCallback    = callback;
  kbContextData = contextData || null;
  kbNum.onConfirm = (val) => { closeKbNum(); if (kbCallback) kbCallback(val, kbContextData); };
  kbNum.onCancel  = closeKbNum;
  document.getElementById('kbNumOverlay').classList.add('visible');
  screen = 'kbNum';
}

function closeKbNum() {
  document.getElementById('kbNumOverlay').classList.remove('visible');
  screen = kbPrevScreen;
  if (screen === 'iface') XeSettings.Network.renderIfaceOverlay();
}

/* ═══════════════════════════════════════════════════════════════
   GESTION DES ONGLETS
═══════════════════════════════════════════════════════════════ */
function selectTab(tabId) {
  /* Ne jamais laisser l'édition rotation ouverte au changement d'onglet
     (clic direct sur la sidebar par ex., qui ne passe pas par onKey) —
     sinon rotEditing reste bloqué à true et réapparaît au retour. */
  if (typeof XeSettings !== 'undefined' && XeSettings.Display?.closeRotEditing) {
    XeSettings.Display.closeRotEditing();
  }
  activeTab = tabId;
  document.querySelectorAll('.tab-content').forEach(el => { el.style.display = 'none'; });
  const t = document.getElementById('tab-' + tabId);
  if (t) t.style.display = 'block';
  document.querySelectorAll('.sidebar-item').forEach((el, i) => {
    el.classList.toggle('active', TABS[i] === tabId);
  });
  if (tabId === 'network') {
    XeSettings.Network.loadInterfaces();
    XeSettings.Network.loadCurrentSsid();
    XeSettings.Network.startIfacePolling();
  } else {
    XeSettings.Network.stopIfacePolling();
  }
  if (tabId === 'bluetooth')   XeSettings.Bluetooth.load();
  if (tabId === 'controllers') XeSettings.Controllers.renderDeviceMaps();
  if (tabId === 'jellyfin')    { XeSettings.Jellyfin.updateConfigStatus(); XeSettings.Jellyfin.renderDeviceList(); }
  rowFocusMap[tabId] = 0;
  updateContentFocus();
}

/* ═══════════════════════════════════════════════════════════════
   FOCUS SIDEBAR
═══════════════════════════════════════════════════════════════ */
function updateSidebarFocus() {
  document.querySelectorAll('.sidebar-item').forEach((el, i) => {
    el.classList.toggle('active',   TABS[i] === activeTab);
    el.classList.toggle('focused',  sidebarFocused && i === sidebarFocusIdx);
  });
}

/* ═══════════════════════════════════════════════════════════════
   FOCUS CONTENU
═══════════════════════════════════════════════════════════════ */
function getContentRows() {
  if (screen === 'btAction') return [];
  const t = document.getElementById('tab-' + activeTab);
  if (!t) return [];
  return Array.from(t.querySelectorAll(
    '.settings-row, .wifi-network, .wifi-hidden-header, .iface-item, ' +
    '.iface-field-value, .iface-apply-btn, .bt-item, .device-item, ' +
    '.option-item, .jf-key-btn'
  )).filter(el => {
    if (el.classList.contains('option-item')) {
      const parent = el.closest('[id$="-options"], [id$="OptionList"]')?.parentElement;
      return parent ? parent.style.display !== 'none' : true;
    }
    if (el.classList.contains('iface-field-value') || el.classList.contains('iface-apply-btn')) {
      const panel = el.closest('.iface-config-panel');
      return panel ? panel.style.display !== 'none' : true;
    }
    if (el.classList.contains('wifi-network')) {
      const hiddenBtList  = el.closest('#hiddenBtList');
      if (hiddenBtList)  return hiddenBtList.style.display !== 'none';
    }
    return true;
  });
}

const BT_MODAL_SCREENS = ['btScan', 'btBusy', 'btAction'];

function updateContentFocus() {
  updateSidebarFocus();
  /* Tant qu'un overlay Bluetooth est ouvert, plus aucune ligne de la page
     située derrière ne garde le focus. */
  if (BT_MODAL_SCREENS.includes(screen)) {
    document.querySelectorAll('#tab-bluetooth .active').forEach(el => el.classList.remove('active'));
    return;
  }
  const rows = getContentRows();
  rows.forEach((el, i) => {
    el.classList.toggle('active', !sidebarFocused && i === rowFocusMap[activeTab]);
  });
}

/* ═══════════════════════════════════════════════════════════════
   DROPDOWN HELPERS
═══════════════════════════════════════════════════════════════ */
function openDropdown(opts, currentIdx, selectFn, closeFn) {
  activeDropdown = { opts, selIdx: 0, select: selectFn, close: closeFn, originRowIdx: rowFocusMap[activeTab] };
  requestAnimationFrame(() => updateDropdownFocus());
}

function closeDropdown() {
  if (!activeDropdown) return;
  const originIdx = activeDropdown.originRowIdx;
  activeDropdown.close();
  activeDropdown = null;
  if (originIdx !== undefined) rowFocusMap[activeTab] = originIdx;
  updateContentFocus();
}

function updateDropdownFocus() {
  if (!activeDropdown) return;
  const tab = document.getElementById('tab-' + activeTab);
  if (!tab) return;
  const visibleList = Array.from(tab.querySelectorAll('.option-list')).find(el => {
    const parent = el.parentElement;
    return parent && parent.style.display !== 'none';
  });
  if (!visibleList) return;
  const items = Array.from(visibleList.querySelectorAll('.option-item'));
  items.forEach((el, i) => {
    el.classList.toggle('active', i === activeDropdown.selIdx);
    if (i === activeDropdown.selIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

/* ═══════════════════════════════════════════════════════════════
   ACTIVATEROW — dispatcher clic/entrée sur une ligne
═══════════════════════════════════════════════════════════════ */
function activateRow(el) {
  const action = el.dataset.action;

  if (el.classList.contains('wifi-network')) {
    const ssid = el.querySelector('.wifi-ssid')?.textContent;
    if (ssid) XeSettings.Network.connectWifi(XeSettings.Network.wifiNetworks.find(n => n.ssid === ssid));
    return;
  }
  if (el.classList.contains('iface-item')) {
    const allItems = Array.from(document.querySelectorAll('.iface-item'));
    const idx = allItems.indexOf(el);
    if (idx >= 0) XeSettings.Network.openIfaceOverlay(idx);
    return;
  }
  /* Appareils (onglets Manettes et Jellyfin) : Entrée / Triangle doivent faire
     la même chose qu'un clic — leur écouteur 'click' ouvre le panneau d'actions
     (Manettes) ou le mapper JMP (Jellyfin). Sans cette branche, seul le clic
     souris fonctionnait : la navigation clavier/manette tombait dans le vide. */
  if (el.classList.contains('device-item')) {
    el.click();
    return;
  }
  if (el.classList.contains('bt-item')) {
    /* Ligne de la liste « Appareils masqués » : Entrée / clic = démasquer. */
    if (el.dataset.btHidden) { XeSettings.Bluetooth.unhideDevice(el.dataset.mac); return; }
    const mac      = el.dataset.mac;
    const isPaired = el.dataset.bttype === 'paired';
    const dev      = isPaired
      ? XeSettings.Bluetooth.btPaired.find(d => d.mac === mac)
      : XeSettings.Bluetooth.btScanResults.find(d => d.mac === mac);
    if (dev) XeSettings.Bluetooth.openActionOverlay(dev, isPaired);
    return;
  }

  if      (action === 'back')          { if (window.xeLauncher) window.xeLauncher.goBack(); else window.location.href = 'menu.html'; }
  else if (action === 'update')        XeSettings.System.doUpdate();
  else if (action === 'reboot')        { if (window.xeLauncher) window.xeLauncher.systemReboot(); }
  else if (action === 'shutdown')      { if (window.xeLauncher) window.xeLauncher.systemShutdown(); }
  else if (action === 'wifi-scan')     XeSettings.Network.doWifiScan();
  else if (action === 'wifi-known')    XeSettings.Network.openKnownOverlay();
  else if (action === 'wifi-hide')     XeSettings.Network.openHiddenOverlay();
  else if (action === 'bt-scan')       XeSettings.Bluetooth.doScan();
  else if (action === 'bt-hide')       XeSettings.Bluetooth.toggleHiddenList();
  else if (action === 'map-remote')    { sessionStorage.removeItem('mapper_deviceId'); window.location.href = 'mapper.html'; }
  else if (action === 'clear-maps')    { mapper.clearAll(); toast.show('Mappages supprim\u00e9s', false); XeSettings.Controllers.renderDeviceMaps(); }
  else if (action === 'jf-configure')  window.location.href = 'JMPmapper.html';
  else if (action === 'apply-display') XeSettings.Display.applyDisplay();
  else if (action === 'refresh-sinks') XeSettings.Audio.manualRefresh();
  else if (el.id === 'row-bt-power')   XeSettings.Bluetooth.togglePower(el);
  else if (el.id === 'row-resolution') XeSettings.Display.toggleResPanel();
  else if (el.id === 'row-rotation')   XeSettings.Display.toggleRotEditing();
  else if (el.id === 'row-audio-out')  XeSettings.Audio.toggleOutDropdown();
  else if (el.id === 'row-volume')     XeSettings.Audio.toggleVolumeOpen();
  /* Rotation tactile : taper la ligne ouvre, retaper applique (voir
     toggleRotEditing) — les flèches < > sont câblées séparément dans
     settings-display.js (init/_initButtons), pas ici. */
}

/* ═══════════════════════════════════════════════════════════════
   MAPPER UI INLINE (settings controllers)
═══════════════════════════════════════════════════════════════ */
function openMapperUI(deviceId) {
  mapperDeviceId    = deviceId;
  mapperCurrentIdx  = 0;
  mapperResult      = {};
  mapperActive      = true;
  mapperWaiting     = false;
  if (deviceId === REMOTE_DEVICE_ID) remoteCapture.start(REMOTE_DEVICE_ID);
  const el = document.getElementById('mapperOverlay');
  el.innerHTML = '';
  el.className = 'mapper-overlay visible';
  screen = 'mapper';

  const title = document.createElement('div');
  title.className = 'mapper-title';
  title.textContent = 'Configuration du p\u00e9riph\u00e9rique';
  el.appendChild(title);

  const dev = document.createElement('div');
  dev.className   = 'mapper-device';
  dev.textContent = deviceId === REMOTE_DEVICE_ID ? 'T\u00e9l\u00e9commande / nouvel appareil' : deviceId.substring(0, 55);
  el.appendChild(dev);

  const act = document.createElement('div');
  act.className = 'mapper-actions';
  act.id        = 'mapperAct2';
  el.appendChild(act);

  const grid = document.createElement('div');
  grid.className = 'mapper-grid';
  grid.id        = 'mapperGrid3';
  el.appendChild(grid);

  const hint = document.createElement('div');
  hint.className   = 'mapper-hint';
  hint.textContent = 'Appuyez le bouton ou la direction correspondant \u00e0 chaque action. \u2715 = passer';
  el.appendChild(hint);

  const skip = document.createElement('button');
  skip.className   = 'btn';
  skip.style.marginTop = '12px';
  skip.textContent = 'Utiliser les valeurs par d\u00e9faut';
  skip.addEventListener('click', () => { mapper.save(deviceId, mapper.getDefault()); closeMapperUI(); });
  el.appendChild(skip);

  renderMapperUI();
  setTimeout(nextMapperStep, 500);
}

function renderMapperUI() {
  const grid = document.getElementById('mapperGrid3');
  if (!grid) return;
  grid.innerHTML = '';
  XeInput.ACTION_KEYS.forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'mapper-btn'
      + (mapperResult[a.id]                          ? ' assigned'       : '')
      + (i === mapperCurrentIdx && mapperWaiting     ? ' current-target' : '');
    const lbl = document.createElement('span');
    lbl.textContent = a.label;
    item.appendChild(lbl);
    if (mapperResult[a.id]) {
      const kn = document.createElement('span');
      kn.className   = 'mapper-key-name';
      kn.textContent = XeInput.prettyRaw(mapperResult[a.id]) || mapperResult[a.id];
      item.appendChild(kn);
    }
    grid.appendChild(item);
  });
}

function nextMapperStep() {
  if (mapperCurrentIdx >= XeInput.ACTION_KEYS.length) {
    mapper.save(mapperDeviceId, mapperResult);
    closeMapperUI();
    toast.show('Mappage enregistr\u00e9 !', false);
    if (activeTab === 'controllers') XeSettings.Controllers.renderDeviceMaps();
    return;
  }
  mapperWaiting = true;
  const act = document.getElementById('mapperAct2');
  if (act) act.textContent = 'Appuyez pour : ' + XeInput.ACTION_KEYS[mapperCurrentIdx].label;
  renderMapperUI();
}

function closeMapperUI() {
  mapperActive  = false;
  mapperWaiting = false;
  remoteCapture.stop();
  document.getElementById('mapperOverlay').classList.remove('visible');
  document.getElementById('mapperOverlay').innerHTML = '';
  screen = 'main';
}

/* ═══════════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  waitForXeInput(initSettings);
});

function waitForXeInput(cb, attempts) {
  attempts = attempts || 0;
  if (window.XeInput && window.XeInput.Toast && window.XeInput.InputMapper &&
      window.XeInput.EvdevPoller && window.XeInput.RemoteCapture && window.XeInput.VirtualKeyboard) {
    cb();
  } else if (attempts < 50) {
    setTimeout(() => waitForXeInput(cb, attempts + 1), 20);
  } else {
    console.error('XeInput failed to load after 1s');
  }
}

function initSettings() {
  toast  = new XeInput.Toast(document.getElementById('toast'));
  mapper = new XeInput.InputMapper();

  gpPoller = new XeInput.EvdevPoller((resolved) => {
    onKey(resolved, gpPoller._lastGpId || '__keyboard__');
  });
  gpPoller._customMaps = mapper._maps;
  gpPoller._lastGpId   = '__keyboard__';
  gpPoller.onRawEvent  = (raw, gpName) => {
    gpPoller._lastGpId = gpName || '__keyboard__';
    /* Pour le mapper inline et jf-mapping : envoyer le raw BRUT (on veut le code physique) */
    if (mapperActive && mapperWaiting)                                  { onKey(raw, gpName); return; }
    if (screen === 'jf-mapping' && XeSettings.Jellyfin.mappingActive) { onKey(raw, gpName); return; }
    /* Pour la navigation normale : ne rien faire ici, le callback principal de gpPoller
       (passé au constructeur) gère déjà la résolution via _customMaps. */
  };

  remoteCapture = new XeInput.RemoteCapture(
    (raw) => onKey(raw, REMOTE_DEVICE_ID),
    ()    => mapper
  );

  kb = new XeInput.VirtualKeyboard(
    document.getElementById('kbRows'),
    document.getElementById('kbDisplay'),
    document.getElementById('kbOverlay')
  );

  /* Pavé numérique dédié (chiffres, point, effacer, entrée) ; repli sur le
     clavier complet si numpad.js n'est pas chargé. */
  kbNum = XeInput.NumericKeyboard
    ? new XeInput.NumericKeyboard(
        document.getElementById('kbNumRows'),
        document.getElementById('kbNumDisplay')
      )
    : new XeInput.VirtualKeyboard(
        document.getElementById('kbNumRows'),
        document.getElementById('kbNumDisplay'),
        null
      );

  XeInput.requestWakeLock();
  gpPoller.start();

  /* Injecter la référence mapper dans le module controllers */
  if (XeSettings.Controllers._setMapper) XeSettings.Controllers._setMapper(mapper);

  XeSettings.Network.loadHiddenNetworks();
  XeSettings.Network.loadKnownNetworks();
  XeSettings.Bluetooth.loadHiddenDevices();

  document.querySelectorAll('.sidebar-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      sidebarFocusIdx = i;
      sidebarFocused  = false;
      selectTab(TABS[i]);
    });
  });

  /* kbModeLetters/kbModeNums retirés : keyboard.js n'a plus de setMode()
     depuis sa réécriture (grille unique lettres+chiffres+symboles) — ces
     handlers plantaient au clic pour la même raison que openKbNum(). */

  XeSettings.System.loadVersion();
  XeSettings.System.loadSpecs();
  XeSettings.Display.loadDisplayModes();
  XeSettings.Network.loadInterfaces();
  XeSettings.Display.loadSavedSettings();
  XeSettings.Display.loadCurrentDisplay();
  XeSettings.Audio.init();
  XeSettings.Audio.loadSavedSettings();
  XeSettings.Audio.refreshSinks();
  XeSettings.Jellyfin.loadMapping();
  XeSettings.Jellyfin.updateConfigStatus();

  selectTab('system');
  updateSidebarFocus();
  setTimeout(() => { inputReady = true; }, 700);
}

window.addEventListener('gamepadconnected', (e) => {
  if (screen === 'mapper' && !mapper.has(e.gamepad.id)) openMapperUI(e.gamepad.id);
});

/* ═══════════════════════════════════════════════════════════════
   DISPATCHER CLAVIER PRINCIPAL
═══════════════════════════════════════════════════════════════ */
function onKey(raw, deviceId) {
  if (!inputReady) return;

  /* Jellyfin mapping capture (raw) */
  if (screen === 'jf-mapping' && XeSettings.Jellyfin.mappingActive) {
    let rawForJf = raw;
    if (deviceId && deviceId !== '__keyboard__')
      rawForJf = mapper.resolveKey(deviceId, raw) || raw;
    XeSettings.Jellyfin.handleMappingKey(rawForJf);
    return;
  }

  /* Mapper inline capture (raw) */
  if (mapperActive && mapperWaiting) {
    if (mapperDeviceId !== REMOTE_DEVICE_ID) {
      if (mapperDeviceId === '__keyboard__' && deviceId !== '__keyboard__') return;
      if (mapperDeviceId !== '__keyboard__' && deviceId !== '__keyboard__' && deviceId !== mapperDeviceId) return;
    }
    mapperResult[XeInput.ACTION_KEYS[mapperCurrentIdx].id] = raw;
    mapperCurrentIdx++;
    mapperWaiting = false;
    setTimeout(nextMapperStep, 200);
    renderMapperUI();
    return;
  }

  /* Résolution logique */
  const key = (deviceId && deviceId !== '__keyboard__')
    ? mapper.resolveKey(deviceId, raw)
    : raw;
  if (!key) return;

  /* Écrans modaux */
  if (screen === 'kb')           { kb.handleKey(key);    return; }
  if (screen === 'kbNum')        { kbNum.handleKey(key); return; }
  if (screen === 'btScan')       { XeSettings.Bluetooth.scanKey(key);             return; }
  if (screen === 'btBusy')       { return; }   /* appairage / connexion en cours : on ignore tout */
  if (screen === 'btAction')     { XeSettings.Bluetooth.actionKey(key);           return; }
  if (screen === 'deviceAction') { XeSettings.Controllers.deviceActionKey(key);   return; }
  if (screen === 'gpDebug')      { if (key === 'Escape' || key === 'Backspace' || key === 'Back' || key === 'Start') XeSettings.Controllers.closeGpDebug(); return; }
  if (screen === 'iface')        { XeSettings.Network.ifaceOverlayKey(key);       return; }
  if (screen === 'knownOverlay')  { XeSettings.Network.knownOverlayKey(key);       return; }
  if (screen === 'hiddenOverlay') { XeSettings.Network.hiddenOverlayKey(key);      return; }

  /* Dropdown ouvert */
  if (activeDropdown) {
    const dd = activeDropdown;
    if      (key === 'ArrowLeft')                                        { dd.selIdx = Math.max(0, dd.selIdx - 1); updateDropdownFocus(); }
    else if (key === 'ArrowRight')                                       { dd.selIdx = Math.min(dd.opts.length - 1, dd.selIdx + 1); updateDropdownFocus(); }
    else if (key === 'Enter')                                            { dd.select(dd.selIdx); }
    else if (key === 'Escape' || key === 'Backspace' || key === 'Back') { closeDropdown(); updateContentFocus(); }
    return;
  }

  /* Affichage : panneau résolution ouvert, ou ligne rotation en édition —
     priorité totale sur la navigation normale et sur le retour global,
     pour que Retour/Échap annule au lieu de quitter la page.
     IMPORTANT : uniquement quand le focus est réellement dans le contenu
     (!sidebarFocused). rowFocusMap[activeTab] continue de "se souvenir"
     de la ligne rotation même une fois le focus passé dans la sidebar —
     sans cette garde, Entrée sur un onglet de la sidebar rouvrait la
     rotation au lieu d'appeler selectTab(). */
  if (activeTab === 'display' && !sidebarFocused) {
    if (XeSettings.Display.isResOpen()) {
      XeSettings.Display.handleResKey(key);
      return;
    }
    const _rows = getContentRows();
    const _cur  = _rows[rowFocusMap[activeTab]];
    if (_cur && _cur.id === 'row-rotation' &&
        (key === 'Enter' || XeSettings.Display.isRotEditing())) {
      if (XeSettings.Display.handleRotKey(key)) return;
    }
  }

  /* Audio : liste "Sortie audio" ouverte → Haut/Bas y naviguent (pas
     Gauche/Droite, ça n'a pas de sens pour une colonne). Ligne "Volume" →
     Entrée fait apparaître la barre et y déplace le focus (comme
     Rotation/Sortie audio) ; Gauche/Droite n'agissent sur le volume
     qu'une fois la barre ouverte, plus directement depuis la ligne.
     Même garde !sidebarFocused que pour Affichage, pour la même raison. */
  if (activeTab === 'audio' && !sidebarFocused) {
    if (XeSettings.Audio.isOutOpen()) {
      XeSettings.Audio.handleAudioOutKey(key);
      return;
    }
    if (XeSettings.Audio.isVolumeOpen()) {
      XeSettings.Audio.handleVolumeKey(key);
      return;
    }
  }

  /* Retour global */
  if (key === 'Escape' || key === 'Backspace' || key === 'Back' || key === 'Start') {
    if (window.xeLauncher) window.xeLauncher.goBack();
    else window.location.href = 'menu.html';
    return;
  }

  /* Action (Triangle) = Entrée */
  if (key === 'Triangle') {
    const rows2 = getContentRows();
    const cur2  = rows2[rowFocusMap[activeTab]];
    if (cur2) activateRow(cur2);
    return;
  }

  /* Navigation sidebar */
  if (sidebarFocused) {
    if      (key === 'ArrowUp')    { sidebarFocusIdx = Math.max(0, sidebarFocusIdx - 1); updateSidebarFocus(); }
    else if (key === 'ArrowDown')  { sidebarFocusIdx = Math.min(TABS.length - 1, sidebarFocusIdx + 1); updateSidebarFocus(); }
    else if (key === 'ArrowRight') { sidebarFocused = false; updateContentFocus(); }
    else if (key === 'Enter')      { selectTab(TABS[sidebarFocusIdx]); sidebarFocused = false; updateContentFocus(); }
    return;
  }

  /* Navigation contenu */
  if (key === 'ArrowLeft') { sidebarFocused = true; updateContentFocus(); return; }

  const rows       = getContentRows();
  const idx        = rowFocusMap[activeTab];
  const currentRow = rows[idx];

  if (key === 'ArrowUp') {
    rowFocusMap[activeTab] = Math.max(0, idx - 1);
    updateContentFocus();
    rows[rowFocusMap[activeTab]]?.scrollIntoView({ block: 'nearest' });
  } else if (key === 'ArrowDown') {
    rowFocusMap[activeTab] = Math.min(rows.length - 1, idx + 1);
    updateContentFocus();
    rows[rowFocusMap[activeTab]]?.scrollIntoView({ block: 'nearest' });
  } else if (key === 'ArrowRight' && currentRow?.classList.contains('wifi-network')) {
    XeSettings.Network.toggleNetworkVisibility(currentRow, idx);
  } else if (key === 'ArrowRight' && currentRow?.classList.contains('bt-item')) {
    if (currentRow.dataset.btHidden) XeSettings.Bluetooth.unhideDevice(currentRow.dataset.mac);
    else                             XeSettings.Bluetooth.hideDevice(currentRow, idx);
  } else if (key === 'Enter') {
    if (currentRow) activateRow(currentRow);
  }
}

window.addEventListener('error', (e) => {
  console.error('Settings error:', e.error);
  toast.show('Erreur: ' + e.message, true);
});
