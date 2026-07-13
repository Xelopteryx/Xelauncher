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
  kbNum.setMode('nums');
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
    '.option-item, .toggle, .jf-key-btn'
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
      const hiddenNetList = el.closest('#hiddenNetList');
      if (hiddenNetList) return hiddenNetList.style.display !== 'none';
      const hiddenBtList  = el.closest('#hiddenBtList');
      if (hiddenBtList)  return hiddenBtList.style.display !== 'none';
    }
    return true;
  });
}

function updateContentFocus() {
  updateSidebarFocus();
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
  if (el.classList.contains('bt-item')) {
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
  else if (action === 'wifi-hide')     XeSettings.Network.toggleHiddenList();
  else if (action === 'bt-scan')       XeSettings.Bluetooth.doScan();
  else if (action === 'bt-hide')       XeSettings.Bluetooth.toggleHiddenList();
  else if (action === 'map-remote')    { sessionStorage.removeItem('mapper_deviceId'); window.location.href = 'mapper.html'; }
  else if (action === 'clear-maps')    { mapper.clearAll(); toast.show('Mappages supprimés', false); XeSettings.Controllers.renderDeviceMaps(); }
  else if (action === 'jf-configure')  window.location.href = 'JMPmapper.html';
  else if (action === 'apply-display') XeSettings.Display.applyDisplay();
  else if (action === 'apply-audio')   XeSettings.Audio.applyAudio();
  else if (el.id === 'row-bt-power')   XeSettings.Bluetooth.togglePower(el);
  else if (el.id === 'row-resolution') XeSettings.Display.toggleResDropdown();
  else if (el.id === 'row-refresh')    XeSettings.Display.toggleRefDropdown();
  else if (el.id === 'row-rotation')   XeSettings.Display.toggleRotDropdown();
  else if (el.id === 'row-audio-out')  XeSettings.Audio.toggleOutDropdown();
  else if (el.id === 'row-volume')     XeSettings.Audio.toggleVolDropdown();
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
  title.textContent = 'Configuration du périphérique';
  el.appendChild(title);

  const dev = document.createElement('div');
  dev.className   = 'mapper-device';
  dev.textContent = deviceId === REMOTE_DEVICE_ID ? 'Télécommande / nouvel appareil' : deviceId.substring(0, 55);
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
  hint.textContent = 'Appuyez le bouton ou la direction correspondant à chaque action. ✕ = passer';
  el.appendChild(hint);

  const skip = document.createElement('button');
  skip.className   = 'btn';
  skip.style.marginTop = '12px';
  skip.textContent = 'Utiliser les valeurs par défaut';
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
    toast.show('Mappage enregistré !', false);
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

  kbNum = new XeInput.VirtualKeyboard(
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

  document.getElementById('kbModeLetters')?.addEventListener('click', () => kb.setMode('letters'));
  document.getElementById('kbModeNums')?.addEventListener('click',    () => kb.setMode('nums'));

  XeSettings.System.loadVersion();
  XeSettings.Display.loadDisplayModes();
  XeSettings.Network.loadInterfaces();
  XeSettings.Display.loadSavedSettings();
  XeSettings.Display.loadCurrentDisplay();
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
  if (screen === 'btAction')     { XeSettings.Bluetooth.actionKey(key);           return; }
  if (screen === 'deviceAction') { XeSettings.Controllers.deviceActionKey(key);   return; }
  if (screen === 'gpDebug')      { if (key === 'Escape' || key === 'Backspace' || key === 'Back' || key === 'Start') XeSettings.Controllers.closeGpDebug(); return; }
  if (screen === 'iface')        { XeSettings.Network.ifaceOverlayKey(key);       return; }
  if (screen === 'knownOverlay') { XeSettings.Network.knownOverlayKey(key);       return; }

  /* Dropdown ouvert */
  if (activeDropdown) {
    const dd = activeDropdown;
    if      (key === 'ArrowLeft')                                        { dd.selIdx = Math.max(0, dd.selIdx - 1); updateDropdownFocus(); }
    else if (key === 'ArrowRight')                                       { dd.selIdx = Math.min(dd.opts.length - 1, dd.selIdx + 1); updateDropdownFocus(); }
    else if (key === 'Enter')                                            { dd.select(dd.selIdx); }
    else if (key === 'Escape' || key === 'Backspace' || key === 'Back') { closeDropdown(); updateContentFocus(); }
    return;
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
    XeSettings.Bluetooth.hideDevice(currentRow, idx);
  } else if (key === 'Enter') {
    if (currentRow) activateRow(currentRow);
  }
}

window.addEventListener('error', (e) => {
  console.error('Settings error:', e.error);
  toast.show('Erreur: ' + e.message, true);
});
