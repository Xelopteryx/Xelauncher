/**
 * mapper.js
 * Configuration d'un périphérique (télécommande ou manette).
 * Dépendances : input.js (XeInput)
 *
 * Fonctionne en deux phases :
 *   1. holdPanel  — détection de l'appareil (appuyer un bouton → confirmer)
 *   2. mapping    — mapper chaque action sur un raw physique
 *
 * Les raws capturés (KEY_304, ABS_1_neg...) sont stockés dans InputMapper
 * par NOM d'appareil (stable, pas le chemin /dev/input/eventXX).
 */

'use strict';

const GRACE_MS    = 800;
const COOLDOWN_MS = 350;
const CONFIRM_MS  = 3000;
const UNMAPPABLE  = ['ir','sensor','motion','accelero','gyro','touchpad','touch pad','nunchuk extension'];

let toast      = null;
let mapper     = null;
let poller     = null;
let actions    = null;

/* Phase : 'device' | 'mapping' */
let phase = 'device';

/* Appareil sélectionné */
let selectedDeviceId   = null;
let _pendingDeviceId   = null;
let _pendingDeviceTime = 0;
let _confirmTimer      = null;

/* Mapping */
let currentIdx = 0;
let result     = {};
let waiting    = false;
let cooldown   = false;

/* Éléments DOM */
let holdPanel  = null;
let holdLabel  = null;
let holdDevice = null;
let holdBar    = null;
let holdConfirm = null;
let graceBarWrap = null;
let graceBar   = null;
let actionsEl  = null;
let gridEl     = null;
let hintEl     = null;
let skipBtn    = null;
let titleEl    = null;
let deviceEl   = null;

/* deviceId pré-sélectionné (depuis settings controllers) */
const preselectedDeviceId = sessionStorage.getItem('mapper_deviceId') || null;

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  waitForXeInput(initMapper);
});

function waitForXeInput(cb, attempts) {
  attempts = attempts || 0;
  if (window.XeInput && window.XeInput.Toast && window.XeInput.InputMapper &&
      window.XeInput.EvdevPoller && window.XeInput.ACTION_KEYS) {
    cb();
  } else if (attempts < 50) {
    setTimeout(() => waitForXeInput(cb, attempts + 1), 20);
  } else {
    console.error('XeInput failed to load');
  }
}

function isUnmappableDevice(name) {
  if (!name) return false;
  const nl = name.toLowerCase();
  return UNMAPPABLE.some(k => nl.includes(k));
}

function initMapper() {
  toast   = new XeInput.Toast(document.getElementById('toast'));
  mapper  = new XeInput.InputMapper();
  actions = [...XeInput.ACTION_KEYS];

  holdPanel   = document.getElementById('holdPanel');
  holdLabel   = document.getElementById('holdLabel');
  holdDevice  = document.getElementById('holdDevice');
  holdBar     = document.getElementById('holdBar');
  holdConfirm = document.getElementById('holdConfirm');
  graceBarWrap = document.getElementById('graceBarWrap');
  graceBar    = document.getElementById('graceBar');
  actionsEl   = document.getElementById('mapperActions');
  gridEl      = document.getElementById('mapperGrid');
  hintEl      = document.getElementById('mapperHint');
  skipBtn     = document.getElementById('skipBtn');
  titleEl     = document.getElementById('mapperTitle');
  deviceEl    = document.getElementById('mapperDevice');

  skipBtn.addEventListener('click', () => {
    if (selectedDeviceId) mapper.save(selectedDeviceId, mapper.getDefault());
    toast.show('Valeurs par défaut appliquées', false, 1200);
    setTimeout(goBack, 1300);
  });

  /* EvdevPoller en mode rawCapture : reçoit TOUS les events bruts */
  poller = new XeInput.EvdevPoller(function() {});
  poller.rawCapture = true;
  poller.onRawEvent = function(raw, deviceName) {
    if (phase === 'device') {
      onDeviceEvent(deviceName, raw);
    } else if (phase === 'mapping' && waiting) {
      if (selectedDeviceId && deviceName !== selectedDeviceId) return;
      receiveInput(raw);
    }
  };
  poller.start();

  /* Clavier physique — capture directe */
  document.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (phase === 'device') return; /* clavier ignoré en phase détection */
    if (phase === 'mapping' && waiting) receiveInput(e.key);
  }, true);

  /* Si un deviceId est pré-sélectionné (reconfiguration depuis settings) */
  if (preselectedDeviceId && preselectedDeviceId !== 'unknown') {
    selectedDeviceId = preselectedDeviceId;
    sessionStorage.removeItem('mapper_deviceId');
    titleEl.textContent  = 'Reconfiguration';
    deviceEl.textContent = selectedDeviceId;
    showMappingPhase();
  } else {
    showDevicePhase();
  }
}

/* ════════════════════════════════════════
   PHASE 1 : DÉTECTION DU PÉRIPHÉRIQUE
════════════════════════════════════════ */
function showDevicePhase() {
  phase = 'device';
  selectedDeviceId = null;
  _pendingDeviceId = null;
  if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }

  holdPanel.style.display    = 'flex';
  graceBarWrap.style.display = 'none';
  actionsEl.style.display    = 'none';
  gridEl.style.display       = 'none';
  hintEl.style.display       = 'none';
  skipBtn.style.display      = 'none';

  holdLabel.innerHTML     = 'Appuyez sur un bouton du périphérique<br>que vous souhaitez configurer';
  holdDevice.textContent  = '';
  holdConfirm.textContent = '';
  holdBar.style.transition = 'none';
  holdBar.style.width      = '0%';
  titleEl.textContent     = 'Configuration du périphérique';
  deviceEl.textContent    = '';
}

function onDeviceEvent(deviceName, raw) {
  if (!deviceName || deviceName === '__keyboard__' || isUnmappableDevice(deviceName)) return;

  const now = Date.now();
  if (_pendingDeviceId === null) {
    _pendingDeviceId   = deviceName;
    _pendingDeviceTime = now;
    const label = deviceName.length > 60 ? deviceName.slice(0, 60) + '…' : deviceName;
    holdDevice.textContent  = label;
    holdConfirm.textContent = 'Appuyez à nouveau pour confirmer';
    _startConfirmCountdown();
  } else if (deviceName === _pendingDeviceId) {
    if (now - _pendingDeviceTime < 600) return; /* trop rapide */
    _confirmDevice();
  } else {
    /* Autre périphérique détecté */
    if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }
    _pendingDeviceId   = deviceName;
    _pendingDeviceTime = now;
    const label = deviceName.length > 60 ? deviceName.slice(0, 60) + '…' : deviceName;
    holdDevice.textContent  = label;
    holdConfirm.textContent = 'Appuyez à nouveau pour confirmer';
    holdBar.style.transition = 'none';
    holdBar.style.width      = '0%';
    _startConfirmCountdown();
  }
}

function _startConfirmCountdown() {
  if (_confirmTimer) clearInterval(_confirmTimer);
  const start = Date.now();
  requestAnimationFrame(() => {
    holdBar.style.transition = `width ${CONFIRM_MS}ms linear`;
    holdBar.style.width      = '100%';
  });
  _confirmTimer = setInterval(() => {
    if (Date.now() - start >= CONFIRM_MS) {
      clearInterval(_confirmTimer); _confirmTimer = null;
      _confirmDevice();
    }
  }, 100);
}

function _confirmDevice() {
  if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }
  selectedDeviceId = _pendingDeviceId;
  _pendingDeviceId = null;
  titleEl.textContent  = 'Configuration de : ' + selectedDeviceId;
  deviceEl.textContent = selectedDeviceId;
  showMappingPhase();
}

/* ════════════════════════════════════════
   PHASE 2 : MAPPING DES TOUCHES
════════════════════════════════════════ */
function showMappingPhase() {
  phase      = 'mapping';
  currentIdx = 0;
  result     = {};

  holdPanel.style.display    = 'none';
  graceBarWrap.style.display = '';
  actionsEl.style.display    = '';
  gridEl.style.display       = '';
  hintEl.style.display       = '';
  skipBtn.style.display      = '';

  renderGrid();
  startGrace();
}

function startGrace() {
  waiting = false;
  graceBar.style.transition = 'none';
  graceBar.style.width      = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    graceBar.style.transition = `width ${GRACE_MS}ms linear`;
    graceBar.style.width      = '0%';
  }));
  actionsEl.textContent = 'Prêt dans…';
  setTimeout(nextStep, GRACE_MS);
}

function nextStep() {
  if (currentIdx >= actions.length) {
    mapper.save(selectedDeviceId, result);
    actionsEl.textContent = '✓ Configuration terminée !';
    actionsEl.classList.add('done');
    toast.show('Périphérique configuré !', false, 1500);
    setTimeout(goBack, 1600);
    return;
  }
  const action = actions[currentIdx];
  actionsEl.innerHTML = '🔘 Appuyez sur : <strong>' + action.label + '</strong>';
  graceBar.style.transition = 'none';
  graceBar.style.width      = '0%';
  waiting = true;
  renderGrid();
}

function receiveInput(raw) {
  if (!waiting || cooldown) return;
  cooldown = true;
  waiting  = false;
  setTimeout(() => { cooldown = false; }, COOLDOWN_MS);
  result[actions[currentIdx].id] = raw;
  currentIdx++;
  renderGrid();
  if (currentIdx >= actions.length) {
    mapper.save(selectedDeviceId, result);
    actionsEl.textContent = '✓ Configuration terminée !';
    actionsEl.classList.add('done');
    toast.show('Périphérique configuré !', false, 1500);
    setTimeout(goBack, 1600);
  } else {
    actionsEl.textContent = '✓';
    setTimeout(nextStep, 200);
  }
}

/* ── Rendu grille ── */
function renderGrid() {
  gridEl.innerHTML = '';
  actions.forEach((a, i) => {
    const item = document.createElement('div');
    item.className = 'mapper-btn'
      + (result[a.id]                ? ' assigned'       : '')
      + (i === currentIdx && waiting ? ' current-target' : '');
    const lbl = document.createElement('span');
    lbl.textContent = a.label;
    item.appendChild(lbl);
    if (result[a.id]) {
      const kn = document.createElement('span');
      kn.className   = 'mapper-key-name';
      kn.textContent = XeInput.prettyRaw(result[a.id]) || result[a.id];
      item.appendChild(kn);
    }
    gridEl.appendChild(item);
  });
}

function goBack() {
  if (poller) poller.stop();
  if (window.xeLauncher?.offXeInputEvent) window.xeLauncher.offXeInputEvent();
  if (window.xeLauncher?.goBack) window.xeLauncher.goBack();
  else window.location.href = 'menu.html';
}
