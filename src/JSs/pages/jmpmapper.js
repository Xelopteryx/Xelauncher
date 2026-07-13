/**
 * jmpmapper.js
 * Configuration des touches Jellyfin Media Player.
 * Dépendances : input.js (XeInput)
 */

'use strict';

/* ── Constantes ── */
const STORAGE_KEY = 'xelauncher_jf_mapping';
const GRACE_MS    = 700;
const COOLDOWN_MS = 300;

const DIR_ACTIONS = [
  { id:'jf_up',    label:'↑ Haut',   default:'ArrowUp'    },
  { id:'jf_down',  label:'↓ Bas',    default:'ArrowDown'  },
  { id:'jf_left',  label:'← Gauche', default:'ArrowLeft'  },
  { id:'jf_right', label:'→ Droite', default:'ArrowRight' },
];

const BTN_ACTIONS = [
  { id:'jf_ok',   label:'✓ OK',               default:'Enter'  },
  { id:'jf_back', label:'↩ Retour',            default:'Escape' },
  { id:'jf_menu', label:'☰ Menu',              default:'m'      },
  { id:'jf_prev', label:'⏮ Retour arrière',    default:'j'      },
  { id:'jf_next', label:'⏭ Avancer',           default:'l'      },
];

const BTN_INFO = [
  '', '',
  'OK + Retour',
  'OK + Retour + Menu',
  'OK + Retour + Menu + Retour arrière',
  'OK + Retour + Menu + Retour arrière + Avancer',
];

/* ── État ── */
let toast    = null;
let mapper   = null;
const returnTo = sessionStorage.getItem('jmpmap_returnTo') || 'settings.html';

let phase = 'device';

let selectedDeviceId   = null;
let _pendingDeviceId   = null;
let _pendingDeviceTime = 0;
let _confirmTimer      = null;

let btnCount    = 3;
let chooseFocus = 1;
const COUNTS    = [2, 3, 4, 5];

let activeActions = [];
let currentIdx    = 0;
let result        = {};
let waiting       = false;
let cooldown      = false;

const CONFIRM_MS          = 3000;
const UNMAPPABLE_KEYWORDS = ['ir','sensor','motion','accelero','gyro','touchpad','touch pad','nunchuk extension'];

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => {
  waitForXeInput(initJmpMapper);
});

function waitForXeInput(cb, attempts) {
  attempts = attempts || 0;
  if (window.XeInput && window.XeInput.Toast && window.XeInput.InputMapper && window.XeInput.prettyRaw) {
    cb();
  } else if (attempts < 50) {
    setTimeout(() => waitForXeInput(cb, attempts + 1), 20);
  } else {
    console.error('XeInput failed to load after 1s');
  }
}

function initJmpMapper() {
  toast  = new XeInput.Toast(document.getElementById('toast'));
  mapper = new XeInput.InputMapper();

  renderSteps();
  document.getElementById('chooseConfirm').addEventListener('click', confirmCount);
  document.getElementById('skipBtn').addEventListener('click', skipToDefaults);

  /* Anti-doublon : deux nœuds evdev du même appareil peuvent émettre le même event.
     On filtre les events identiques reçus dans une fenêtre de 80ms. */
  let _lastIpcRaw = null;
  let _lastIpcTime = 0;

  if (window.xeLauncher?.onXeInputEvent) {
    window.xeLauncher.offXeInputEvent?.();
    window.xeLauncher.onXeInputEvent((data) => {
      if (!data || !data.device) return;

      /* Utiliser le nom lisible si disponible, sinon le chemin */
      const deviceId = (data.name && data.name !== data.device) ? data.name : data.device;

      if (phase === 'device') {
        receiveDeviceEvent(deviceId);
        return;
      }
      if (phase === 'choose') {
        if (selectedDeviceId && selectedDeviceId !== '__keyboard__' && deviceId !== selectedDeviceId) return;
        const key = data.action || data.raw || data.key;
        if (key) handleChooseKey(key);
        return;
      }
      if (phase === 'mapping' && waiting) {
        if (selectedDeviceId && selectedDeviceId !== '__keyboard__' && deviceId !== selectedDeviceId) return;
        const raw = data.raw || data.action || data.key;
        if (!raw) return;
        /* Dédupliquer : ignorer un raw identique reçu dans les 80ms */
        const now = Date.now();
        if (raw === _lastIpcRaw && now - _lastIpcTime < 80) return;
        _lastIpcRaw  = raw;
        _lastIpcTime = now;
        receiveInput(raw);
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (phase === 'device') return;
    if (phase === 'choose') handleChooseKey(e.key);
    else if (phase === 'mapping' && waiting) receiveInput(e.key);
  }, true);

  startDevicePhase();
}

/* ════════════════════════════════════════
   PHASE DEVICE
════════════════════════════════════════ */
function isUnmappableDevice(name) {
  if (!name) return false;
  const nl = name.toLowerCase();
  return UNMAPPABLE_KEYWORDS.some(k => nl.includes(k));
}

function startDevicePhase() {
  phase            = 'device';
  selectedDeviceId = null;
  _pendingDeviceId = null;
  if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }

  const preselected = sessionStorage.getItem('jmpmap_deviceId');
  if (preselected) {
    sessionStorage.removeItem('jmpmap_deviceId');
    selectedDeviceId = preselected;
    proceedToChoose();
    return;
  }

  document.getElementById('holdPanel').style.display     = 'flex';
  document.getElementById('choosePanel').style.display   = 'none';
  document.getElementById('mapperActions').style.display = 'none';
  _resetHoldUI();
  document.getElementById('mapperHint').textContent = 'Appuyez sur un bouton pour sélectionner le périphérique';
  renderSteps();
}

function _resetHoldUI() {
  document.getElementById('holdLabel').innerHTML     = 'Appuyez sur un bouton du périphérique<br>que vous souhaitez configurer';
  document.getElementById('holdDevice').textContent  = '';
  document.getElementById('holdConfirm').textContent = '';
  document.getElementById('holdBar').style.transition = 'none';
  document.getElementById('holdBar').style.width      = '0%';
}

function receiveDeviceEvent(gpId) {
  if (!gpId || gpId === '__keyboard__' || isUnmappableDevice(gpId)) return;
  const now = Date.now();
  if (_pendingDeviceId === null) {
    _pendingDeviceId   = gpId;
    _pendingDeviceTime = now;
    const label = gpId.length > 60 ? gpId.slice(0, 60) + '…' : gpId;
    document.getElementById('holdDevice').textContent  = label;
    document.getElementById('holdConfirm').textContent = 'Appuyez à nouveau pour confirmer, ou appuyez sur un autre bouton pour changer';
    _startConfirmCountdown();
  } else if (gpId === _pendingDeviceId) {
    if (now - _pendingDeviceTime < 800) return;
    _confirmDevice();
  } else {
    if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }
    _pendingDeviceId   = gpId;
    _pendingDeviceTime = now;
    const label = gpId.length > 60 ? gpId.slice(0, 60) + '…' : gpId;
    document.getElementById('holdDevice').textContent  = label;
    document.getElementById('holdConfirm').textContent = 'Appuyez à nouveau pour confirmer, ou appuyez sur un autre bouton pour changer';
    document.getElementById('holdBar').style.transition = 'none';
    document.getElementById('holdBar').style.width      = '0%';
    _startConfirmCountdown();
  }
}

function _startConfirmCountdown() {
  if (_confirmTimer) clearInterval(_confirmTimer);
  const start = Date.now();
  requestAnimationFrame(() => {
    document.getElementById('holdBar').style.transition = 'width ' + CONFIRM_MS + 'ms linear';
    document.getElementById('holdBar').style.width      = '100%';
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
  proceedToChoose();
}

function proceedToChoose() {
  phase = 'choose';
  document.getElementById('mapperActions').style.display = 'none';
  document.getElementById('holdPanel').style.display     = 'none';
  const panel = document.getElementById('choosePanel');
  panel.style.display = 'flex';
  panel.innerHTML = `
    <div class="jmp-choose-label">Combien de boutons supplémentaires<br>possède votre télécommande&nbsp;?</div>
    <div class="jmp-count-row" id="countRow"></div>
    <div class="jmp-action-info" id="countInfo"></div>
    <button class="btn" id="chooseConfirmInner">Confirmer</button>
  `;
  document.getElementById('chooseConfirmInner').addEventListener('click', confirmCount);
  renderCountBtns();
  updateCountInfo();
  renderSteps();
  document.getElementById('mapperHint').textContent = '↑↓←→ naviguer · Entrée confirmer';
}

/* ════════════════════════════════════════
   PHASE CHOOSE
════════════════════════════════════════ */
function renderCountBtns() {
  const row = document.getElementById('countRow');
  if (!row) return;
  row.innerHTML = '';
  COUNTS.forEach((c, i) => {
    const btn = document.createElement('div');
    btn.className = 'jmp-count-btn'
      + (i === chooseFocus ? ' jmp-focused'  : '')
      + (c === btnCount    ? ' jmp-selected' : '');
    btn.textContent = c;
    btn.addEventListener('click', () => { btnCount = c; chooseFocus = i; renderCountBtns(); updateCountInfo(); });
    row.appendChild(btn);
  });
}

function updateCountInfo() {
  const el = document.getElementById('countInfo');
  if (el) el.textContent = 'Boutons supplémentaires : ' + BTN_INFO[btnCount];
}

function handleChooseKey(key) {
  const norm = { up:'ArrowUp', down:'ArrowDown', left:'ArrowLeft', right:'ArrowRight', confirm:'Enter', back:'Escape' };
  const k    = norm[key] || key;
  if      (k === 'ArrowLeft'  || k === 'ArrowUp')    { chooseFocus = Math.max(0, chooseFocus - 1); btnCount = COUNTS[chooseFocus]; renderCountBtns(); updateCountInfo(); }
  else if (k === 'ArrowRight' || k === 'ArrowDown')   { chooseFocus = Math.min(COUNTS.length - 1, chooseFocus + 1); btnCount = COUNTS[chooseFocus]; renderCountBtns(); updateCountInfo(); }
  else if (k === 'Enter')  confirmCount();
  else if (k === 'Escape') goBack();
}

function confirmCount() {
  phase         = 'mapping';
  activeActions = [...DIR_ACTIONS, ...BTN_ACTIONS.slice(0, btnCount)];
  currentIdx    = 0;
  result        = {};

  /* Pré-charger le mapping existant pour cet appareil si disponible */
  try {
    const allMaps = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const deviceKey = selectedDeviceId || '__keyboard__';
    if (allMaps[deviceKey]) {
      Object.assign(result, allMaps[deviceKey]);
      delete result['__btncount'];
    }
  } catch(e) {}

  document.getElementById('choosePanel').style.display   = 'none';
  document.getElementById('mapperGrid').style.display    = '';
  document.getElementById('mapperActions').style.display = '';
  document.getElementById('graceWrap').style.display     = '';
  document.getElementById('skipBtn').style.display       = '';
  document.getElementById('mapperHint').textContent      = 'Appuyez sur le bouton correspondant';

  renderSteps();
  renderGrid();
  startGrace();
}

/* ════════════════════════════════════════
   PHASE MAPPING
════════════════════════════════════════ */
function startGrace() {
  waiting = false;
  const graceBar = document.getElementById('graceBar');
  graceBar.style.transition = 'none';
  graceBar.style.width      = '100%';
  document.getElementById('mapperActions').textContent = 'Prêt dans…';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    graceBar.style.transition = `width ${GRACE_MS}ms linear`;
    graceBar.style.width      = '0%';
  }));
  setTimeout(nextStep, GRACE_MS);
}

function nextStep() {
  if (currentIdx >= activeActions.length) { finishMapping(); return; }
  const action = activeActions[currentIdx];
  document.getElementById('mapperActions').innerHTML =
    '🔘 Appuyez sur : <strong>' + action.label + '</strong>';
  document.getElementById('graceBar').style.transition = 'none';
  document.getElementById('graceBar').style.width      = '0%';
  waiting = true;
  renderGrid();
}

function receiveInput(raw) {
  if (phase !== 'mapping' || !waiting || cooldown) return;
  cooldown = true;
  waiting  = false;
  setTimeout(() => { cooldown = false; }, COOLDOWN_MS);
  result[activeActions[currentIdx].id] = raw;
  currentIdx++;
  renderGrid();
  renderSteps();
  if (currentIdx >= activeActions.length) finishMapping();
  else { document.getElementById('mapperActions').textContent = '✓'; setTimeout(nextStep, 180); }
}

async function finishMapping() {
  phase = 'done';
  /* Attendre la persistance sur disque avant que l'utilisateur puisse lancer JD */
  await saveMapping();
  document.getElementById('mapperActions').textContent = '✓ Configuration terminée !';
  document.getElementById('mapperActions').classList.add('done');
  toast.show('Touches Jellyfin configurées !', false, 1500);
  setTimeout(goBack, 1600);
}

async function skipToDefaults() {
  phase = 'done';
  let allMaps = {};
  try { allMaps = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch(e) {}
  const deviceKey = selectedDeviceId || '__keyboard__';
  const defaults = {};
  [...DIR_ACTIONS, ...BTN_ACTIONS].forEach(a => { defaults[a.id] = a.default; });
  defaults['__btncount'] = btnCount;
  allMaps[deviceKey] = defaults;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(allMaps)); } catch(e) {}
  if (window.xeLauncher?.saveJfMapping) await window.xeLauncher.saveJfMapping(allMaps);
  toast.show('Valeurs par défaut appliquées', false, 1500);
  setTimeout(goBack, 1600);
}

async function saveMapping() {
  /* Charger la structure existante pour merger sans écraser les autres appareils */
  let allMaps = {};
  try { allMaps = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch(e) {}

  const deviceKey = selectedDeviceId || '__keyboard__';
  const devMap = {};
  for (const [k, v] of Object.entries(result)) {
    if (!k.startsWith('__')) devMap[k] = v;
  }
  devMap['__btncount'] = btnCount;
  allMaps[deviceKey] = devMap;

  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(allMaps)); } catch(e) {}
  if (window.xeLauncher?.saveJfMapping) await window.xeLauncher.saveJfMapping(allMaps);
}

/* ════════════════════════════════════════
   RENDU
════════════════════════════════════════ */
function renderGrid() {
  const gridEl = document.getElementById('mapperGrid');
  if (!gridEl) return;
  gridEl.innerHTML = '';
  activeActions.forEach((a, i) => {
    const item       = document.createElement('div');
    const isDir      = i < DIR_ACTIONS.length;
    const isAssigned = !!result[a.id];
    const isCurrent  = i === currentIdx && waiting;
    item.className = 'mapper-btn'
      + (isDir      ? ' always-on'      : '')
      + (isAssigned ? ' assigned'       : '')
      + (isCurrent  ? ' current-target' : '');
    const lbl = document.createElement('span');
    lbl.textContent = a.label;
    item.appendChild(lbl);
    if (isAssigned) {
      const kn = document.createElement('span');
      kn.className   = 'mapper-key-name';
      kn.textContent = XeInput.prettyRaw(result[a.id]) || result[a.id];
      item.appendChild(kn);
    }
    gridEl.appendChild(item);
  });
}

function renderSteps() {
  const stepsEl = document.getElementById('jmpSteps');
  if (!stepsEl) return;
  stepsEl.innerHTML = '';
  const totalSteps = 2 + (phase === 'mapping' || phase === 'done' ? DIR_ACTIONS.length + btnCount : 0);
  for (let i = 0; i < totalSteps; i++) {
    const s = document.createElement('div');
    let cls = 'jmp-step';
    if (phase === 'device') {
      cls += i === 0 ? ' current' : '';
    } else if (phase === 'choose') {
      cls += i === 0 ? ' done' : i === 1 ? ' current' : '';
    } else {
      if (i < 2) {
        cls += ' done';
      } else {
        const btnStep = i - 2;
        if (phase === 'done' || btnStep < currentIdx) cls += ' done';
        else if (btnStep === currentIdx)              cls += ' current';
      }
    }
    s.className = cls;
    stepsEl.appendChild(s);
  }
}

function goBack() {
  sessionStorage.removeItem('jmpmap_returnTo');
  if (window.xeLauncher?.goBack) window.xeLauncher.goBack();
  else window.location.href = returnTo;
}
