/**
 * menu.js
 * Logique du menu principal XeLauncher.
 * Dépendances : input.js (XeInput)
 */

'use strict';

/* ── État ── */
let current       = 0;
let topBarFocusIdx = -1;
let powerFocusIdx  = 0;
const POWER_ITEMS  = ['pwrRestart', 'pwrShutdown', 'pwrCancel'];

let toast    = null;
let mapper   = null;
let gpPoller = null;

const UNMAPPABLE_KEYWORDS = ['ir','sensor','motion','accelero','gyro','touchpad','touch pad','nunchuk extension'];
function isUnmappableDevice(name) {
  if (!name) return false;
  const nl = name.toLowerCase();
  return UNMAPPABLE_KEYWORDS.some(k => nl.indexOf(k) >= 0);
}

let inputReady = false;
let konamiIdx  = 0;
const KONAMI   = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight'];

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  waitForXeInput(initMenu);
});

function waitForXeInput(cb, attempts) {
  attempts = attempts || 0;
  if (window.XeInput && window.XeInput.Toast && window.XeInput.InputMapper && window.XeInput.EvdevPoller) {
    cb();
  } else if (attempts < 50) {
    setTimeout(() => waitForXeInput(cb, attempts + 1), 20);
  } else {
    console.error('XeInput failed to load after 1s');
  }
}

function initMenu() {
  toast    = new XeInput.Toast(document.getElementById('toast'));
  mapper   = new XeInput.InputMapper();
  gpPoller = new XeInput.EvdevPoller((resolved) => {
    onKey(resolved, gpPoller._lastGpId || '__keyboard__');
  });
  gpPoller._customMaps = mapper._maps;
  gpPoller._lastGpId   = '__keyboard__';
  gpPoller.onRawEvent  = (raw, gpName) => {
    gpPoller._lastGpId = gpName || '__keyboard__';
    if (gpName && gpName !== '__keyboard__' && !mapper.has(gpName) && !isUnmappableDevice(gpName)) {
      openMapper(gpName, 'remote');
    }
  };

  XeInput.requestWakeLock();
  gpPoller.start();
  setTimeout(() => { inputReady = true; }, 300);
  renderCards();
  setupCardClicks();
  setupPowerBtns();
  updateTopBarFocus();
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('topBarClose').addEventListener('click', closeTopBar);
}

/* ── Rendu ── */
function renderCards() {
  document.getElementById('card0').className = 'card card-retro '    + (current === 0 ? 'active' : 'inactive');
  document.getElementById('card1').className = 'card card-jellyfin ' + (current === 1 ? 'active' : 'inactive');
}

function setupCardClicks() {
  document.getElementById('card0').addEventListener('click',    () => { current = 0; renderCards(); });
  document.getElementById('card1').addEventListener('click',    () => { current = 1; renderCards(); });
  document.getElementById('card0').addEventListener('dblclick', launchCurrent);
  document.getElementById('card1').addEventListener('dblclick', launchCurrent);
}

function setupPowerBtns() {
  document.getElementById('pwrRestart').addEventListener('click',  () => doPower(0));
  document.getElementById('pwrShutdown').addEventListener('click', () => doPower(1));
  document.getElementById('pwrCancel').addEventListener('click',   closePower);
}

function updateTopBarFocus() {
  ['settingsBtn','topBarClose'].forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', i === topBarFocusIdx);
  });
}

function updatePowerFocus() {
  POWER_ITEMS.forEach((id, i) => {
    document.getElementById(id).classList.toggle('active', i === powerFocusIdx);
  });
}

/* ── Navigation ── */
function openMapper(deviceId, type) {
  sessionStorage.setItem('mapper_deviceId', deviceId);
  sessionStorage.setItem('mapper_type', type || 'remote');
  window.location.href = 'mapper.html';
}

function launchCurrent() {
  if (!window.xeLauncher) return;
  const card = document.getElementById('card' + current);
  card.classList.add('pressing');
  setTimeout(() => {
    card.classList.remove('pressing');
    if (current === 0) {
      document.getElementById('loadingText').textContent = 'Lancement de RetroPie…';
      document.getElementById('loadingOverlay').classList.add('visible');
      window.xeLauncher.launchRetropie()
        .then(() => { document.getElementById('loadingOverlay').classList.remove('visible'); })
        .catch(() => { document.getElementById('loadingOverlay').classList.remove('visible'); toast.show('Impossible de lancer RetroPie', true); });
    } else {
      document.getElementById('loadingText').textContent = 'Connexion au réseau…';
      document.getElementById('loadingOverlay').classList.add('visible');
      window.xeLauncher.launchJellyfin()
        .then(() => { document.getElementById('loadingOverlay').classList.remove('visible'); })
        .catch(() => { document.getElementById('loadingOverlay').classList.remove('visible'); toast.show('Impossible de lancer Jellyfin', true); });
    }
  }, 350);
}

function openSettings() {
  closeTopBar();
  if (window.xeLauncher?.openSettings) window.xeLauncher.openSettings();
  else window.location.href = 'settings.html';
}

function openTopBar() {
  document.getElementById('topBar').classList.add('visible');
  topBarFocusIdx = -1;
  updateTopBarFocus();
}

function closeTopBar() {
  document.getElementById('topBar').classList.remove('visible');
  topBarFocusIdx = -1;
  updateTopBarFocus();
}

function openPower() {
  powerFocusIdx = 0;
  updatePowerFocus();
  document.getElementById('powerOverlay').classList.add('visible');
}

function closePower() {
  document.getElementById('powerOverlay').classList.remove('visible');
}

function doPower(idx) {
  closePower();
  if (!window.xeLauncher) return;
  document.getElementById('loadingText').textContent = idx === 0 ? 'Redémarrage…' : 'Arrêt…';
  document.getElementById('loadingOverlay').classList.add('visible');
  if (idx === 0) window.xeLauncher.systemReboot();
  else           window.xeLauncher.systemShutdown();
}

/* ── Dispatcher clavier ── */
function onKey(raw, deviceId) {
  if (!inputReady) return;

  if (raw === 'F5') {
    if (!mapper) return;
    mapper.clearAll();
    gpPoller._customMaps = mapper._maps;
    toast.show('Mappings réinitialisés', false, 3000);
    return;
  }

  const key = (deviceId && deviceId !== '__keyboard__')
    ? (mapper.resolveKey(deviceId, raw) || raw)
    : raw;
  if (!key) return;

  // Konami
  if (key === KONAMI[konamiIdx]) {
    konamiIdx++;
    if (konamiIdx === KONAMI.length) { openTopBar(); konamiIdx = 0; }
  } else { konamiIdx = 0; }

  // Power menu
  if (document.getElementById('powerOverlay').classList.contains('visible')) {
    if      (key === 'ArrowUp')                        { powerFocusIdx = (powerFocusIdx - 1 + 3) % 3; updatePowerFocus(); }
    else if (key === 'ArrowDown')                      { powerFocusIdx = (powerFocusIdx + 1) % 3; updatePowerFocus(); }
    else if (key === 'Enter') {
      if      (powerFocusIdx === 0) doPower(0);
      else if (powerFocusIdx === 1) doPower(1);
      else closePower();
    }
    else if (key === 'Escape' || key === 'Start') closePower();
    return;
  }

  // Top bar
  if (document.getElementById('topBar').classList.contains('visible')) {
    if (topBarFocusIdx >= 0) {
      if      (key === 'ArrowLeft')  { topBarFocusIdx = Math.max(0, topBarFocusIdx - 1); updateTopBarFocus(); }
      else if (key === 'ArrowRight') { topBarFocusIdx = Math.min(1, topBarFocusIdx + 1); updateTopBarFocus(); }
      else if (key === 'ArrowDown')  { topBarFocusIdx = -1; updateTopBarFocus(); }
      else if (key === 'Enter')      { if (topBarFocusIdx === 0) openSettings(); else closeTopBar(); }
      else if (key === 'Escape')     closeTopBar();
      else if (key === 'Start')      { closeTopBar(); openPower(); }
    } else {
      if      (key === 'ArrowUp')    { topBarFocusIdx = 0; updateTopBarFocus(); }
      else if (key === 'ArrowLeft')  { current = 0; renderCards(); }
      else if (key === 'ArrowRight') { current = 1; renderCards(); }
      else if (key === 'Enter')      launchCurrent();
      else if (key === 'Escape')     closeTopBar();
      else if (key === 'Start')      { closeTopBar(); openPower(); }
    }
    return;
  }

  // Menu principal
  if      (key === 'ArrowLeft')  { current = 0; renderCards(); }
  else if (key === 'ArrowRight') { current = 1; renderCards(); }
  else if (key === 'Enter')      launchCurrent();
  else if (key === 'Start')      openPower();
}
