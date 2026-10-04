/**
 * mapper.js
 * Configuration d'un périphérique (clavier, manette, télécommande).
 * Dépendances : input.js (XeInput)
 *
 * Modèle : une liste de BOUTONS, chacun associé à UNE action parmi les 8
 * (haut, bas, gauche, droite, confirmer, retour, menu, action).
 *   - plusieurs boutons peuvent déclencher la même action (ex. la croix ET un
 *     joystick pour « Haut ») ;
 *   - un bouton ne peut avoir qu'une seule action ;
 *   - chacune des 8 actions doit garder au moins un bouton.
 * « Bouton » = touche de clavier, bouton de manette, direction d'un joystick
 * ou de la croix, gâchette analogique... tout ce que xe_input.py relaie.
 *
 * Flux :
 *   1. device  — détection de l'appareil (appuyer un bouton → confirmer)
 *   2. mapping — guidé : un bouton pour chaque action encore sans bouton
 *   3. recap   — liste des boutons ; « ＋ Ajouter un bouton » (appuyer sur le
 *                nouveau bouton, puis choisir son action) ; modifier l'action
 *                d'un bouton ou le supprimer ; enregistrement explicite.
 *
 * Le mappage enregistré est strict : un bouton non mappé ne fait rien.
 * Les raws viennent exclusivement d'evdev (xe_input.py v3), claviers compris.
 */

'use strict';

const GRACE_MS         = 700;
const COOLDOWN_MS      = 300;
const CONFIRM_MS       = 3000;
const CAPTURE_MS       = 10000;
const CAPTURE_GRACE_MS = 450;
const UNMAPPABLE       = ['sensor','motion','accelero','gyro','touchpad','touch pad','nunchuk extension'];
/* « IR » et « IMU » : mots entiers seulement (« Wireless » contient « ir »). */
const UNMAPPABLE_WORDS = /(^|[^a-z])(ir|imu)($|[^a-z])/;

let toast = null, mapper = null, poller = null;
let ALL = [];

/* Phase : 'device' | 'mapping' | 'recap' | 'done' */
let phase = 'device';

let selectedDeviceId = null, selectedKind = null;
let _pendingDeviceId = null, _pendingKind = null, _pendingDeviceTime = 0;
let _confirmTimer = null, _anyEvent = false, _noSignalTimer = null;

let working = {};                 // actionId -> [raw, ...]
let seqList = [], seqIdx = 0, waiting = false, cooldown = false;

/* Récap : view = 'list' | 'menu' (actions d'un bouton) | 'picker' (choix d'une action) */
let view = 'list', recapIdx = 0, subIdx = 0;
let menuRaw = null;               // bouton dont on ouvre le menu
let pendingRaw = null;            // nouveau bouton en attente d'une action
let pendingFrom = null;           // bouton existant dont on change l'action
let capturing = null;             // { action: id|null } — null = nouveau bouton, action à choisir ensuite
let captureStart = 0, captureLeft = 0, captureTimer = null;
let _lastRaw = null, _lastRawT = 0, _warnTimer = null;
let flash = null, flashTimer = null;   // { raw } : bouton refusé (déjà pris) — boîtes en rouge ~1 s

const preselectedDeviceId = sessionStorage.getItem('mapper_deviceId') || null;

let holdPanel, holdLabel, holdDevice, holdBar, holdConfirm, graceBarWrap, graceBar,
    actionsEl, gridEl, listEl, hintEl, cancelBtn, titleEl, deviceEl;

/* ── Utilitaires ── */
function mk(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls)  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function labelOf(id)   { const a = ALL.find(x => x.id === id); return a ? a.label : id; }
function pretty(raw)   { return XeInput.prettyRaw(raw) || raw; }
function bindsOf(id)   { return working[id] || []; }
function ownerOf(raw)  { const a = ALL.find(x => bindsOf(x.id).indexOf(raw) >= 0); return a ? a.id : null; }
function missing()     { return ALL.filter(a => !bindsOf(a.id).length); }
function addBinding(raw, id) { (working[id] = working[id] || []).push(raw); }
function removeBinding(raw) {
  const id = ownerOf(raw);
  if (id) working[id] = working[id].filter(r => r !== raw);
  return id;
}
/* Un bouton ne peut être retiré / réassigné que si son action en garde un autre */
function canRemove(raw) { const id = ownerOf(raw); return !!id && bindsOf(id).length > 1; }
function cloneAssign(a) { const o = {}; Object.keys(a).forEach(k => { o[k] = a[k].slice(); }); return o; }

/* ── Init ── */
document.addEventListener('DOMContentLoaded', () => { waitForXeInput(initMapper); });

function waitForXeInput(cb, attempts) {
  attempts = attempts || 0;
  if (window.XeInput && window.XeInput.Toast && window.XeInput.InputMapper &&
      window.XeInput.EvdevPoller && window.XeInput.ALL_ACTION_KEYS) {
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
  if (UNMAPPABLE_WORDS.test(nl)) return true;
  return UNMAPPABLE.some(k => nl.includes(k));
}

function initMapper() {
  toast  = new XeInput.Toast(document.getElementById('toast'));
  mapper = new XeInput.InputMapper();
  ALL    = XeInput.ALL_ACTION_KEYS.slice();

  holdPanel    = document.getElementById('holdPanel');
  holdLabel    = document.getElementById('holdLabel');
  holdDevice   = document.getElementById('holdDevice');
  holdBar      = document.getElementById('holdBar');
  holdConfirm  = document.getElementById('holdConfirm');
  graceBarWrap = document.getElementById('graceBarWrap');
  graceBar     = document.getElementById('graceBar');
  actionsEl    = document.getElementById('mapperActions');
  gridEl       = document.getElementById('mapperGrid');
  listEl       = document.getElementById('mapperList');
  hintEl       = document.getElementById('mapperHint');
  cancelBtn    = document.getElementById('cancelBtn');
  titleEl      = document.getElementById('mapperTitle');
  deviceEl     = document.getElementById('mapperDevice');

  cancelBtn.addEventListener('click', goBack);

  /* Poller en mode rawCapture : reçoit TOUS les raws (touches, boutons, axes) */
  poller = new XeInput.EvdevPoller(function() {});
  poller.rawCapture = true;
  poller.onRawEvent = onRaw;
  poller.start();

  /* Tout passe par evdev : on neutralise seulement le comportement du navigateur. */
  document.addEventListener('keydown', (e) => { e.preventDefault(); e.stopPropagation(); }, true);

  if (preselectedDeviceId && preselectedDeviceId !== 'unknown') {
    selectedDeviceId = preselectedDeviceId;
    sessionStorage.removeItem('mapper_deviceId');
    selectedKind = mapper.getMeta(selectedDeviceId).kind || null;
    titleEl.textContent  = 'Reconfiguration';
    deviceEl.textContent = selectedDeviceId;
    startFlow();
  } else {
    showDevicePhase();
  }
}

/* Dispatcher des raws — dédoublonne (deux nœuds evdev d'un même appareil) */
function onRaw(raw, deviceName, data) {
  _anyEvent = true;
  const now = Date.now();
  if (raw === _lastRaw && now - _lastRawT < 80) return;
  _lastRaw = raw; _lastRawT = now;

  if (phase === 'device') { onDeviceEvent(deviceName, raw, data); return; }
  if (deviceName !== selectedDeviceId) return;
  if (phase === 'mapping') { if (waiting) receiveSeq(raw); }
  else if (phase === 'recap') recapRaw(raw);
}

/* ════════════════════════════════════════
   PHASE 1 : DÉTECTION DU PÉRIPHÉRIQUE
════════════════════════════════════════ */
function show(el, on) { if (el) el.style.display = on ? '' : 'none'; }

function showDevicePhase() {
  phase = 'device';
  selectedDeviceId = null; _pendingDeviceId = null;
  if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }

  holdPanel.style.display = 'flex';
  show(graceBarWrap, false); show(actionsEl, false); show(gridEl, false);
  show(listEl, false); show(hintEl, false);
  show(cancelBtn, true);

  holdLabel.innerHTML     = 'Appuyez sur un bouton du périphérique<br>que vous souhaitez configurer';
  holdDevice.textContent  = '';
  holdConfirm.textContent = '';
  holdBar.style.transition = 'none';
  holdBar.style.width      = '0%';
  _anyEvent = false;
  if (_noSignalTimer) clearTimeout(_noSignalTimer);
  _noSignalTimer = setTimeout(() => {
    if (phase === 'device' && !_anyEvent && _pendingDeviceId === null)
      holdConfirm.textContent = 'Aucun signal reçu — vérifiez que l\'appareil est connecté (bouton Accueil / PS / Guide)';
  }, 10000);
  titleEl.textContent  = 'Configuration du périphérique';
  deviceEl.textContent = '';
}

function onDeviceEvent(deviceName, raw, data) {
  if (!deviceName || deviceName === '__keyboard__') return;
  if (isUnmappableDevice(deviceName)) {
    if (_pendingDeviceId === null) holdConfirm.textContent = 'Entrée ignorée : ' + deviceName.slice(0, 50);
    return;
  }
  const now   = Date.now();
  const label = deviceName.length > 60 ? deviceName.slice(0, 60) + '…' : deviceName;

  if (_pendingDeviceId === null) {
    _pendingDeviceId = deviceName; _pendingKind = (data && data.kind) || null; _pendingDeviceTime = now;
    holdDevice.textContent  = label;
    holdConfirm.textContent = 'Appuyez à nouveau pour confirmer';
    startConfirmCountdown();
  } else if (deviceName === _pendingDeviceId) {
    if (now - _pendingDeviceTime < 600) return;
    confirmDevice();
  } else {
    if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }
    _pendingDeviceId = deviceName; _pendingKind = (data && data.kind) || null; _pendingDeviceTime = now;
    holdDevice.textContent  = label;
    holdConfirm.textContent = 'Appuyez à nouveau pour confirmer';
    holdBar.style.transition = 'none';
    holdBar.style.width      = '0%';
    startConfirmCountdown();
  }
}

function startConfirmCountdown() {
  if (_confirmTimer) clearInterval(_confirmTimer);
  const start = Date.now();
  requestAnimationFrame(() => {
    holdBar.style.transition = 'width ' + CONFIRM_MS + 'ms linear';
    holdBar.style.width      = '100%';
  });
  _confirmTimer = setInterval(() => {
    if (Date.now() - start >= CONFIRM_MS) {
      clearInterval(_confirmTimer); _confirmTimer = null;
      confirmDevice();
    }
  }, 100);
}

function confirmDevice() {
  if (_confirmTimer) { clearInterval(_confirmTimer); _confirmTimer = null; }
  selectedDeviceId = _pendingDeviceId;
  selectedKind     = _pendingKind;
  _pendingDeviceId = null;
  titleEl.textContent  = 'Configuration de : ' + selectedDeviceId;
  deviceEl.textContent = selectedDeviceId;
  startFlow();
}

/* Repart du mappage existant : seules les actions sans bouton sont demandées
   une par une ; si tout est déjà couvert, on ouvre directement la liste. */
function startFlow() {
  working = cloneAssign(mapper.getAssignments(selectedDeviceId));
  seqList = missing();
  if (seqList.length) startSequence(); else enterRecap(false);
}

/* ════════════════════════════════════════
   PHASE 2 : UN BOUTON POUR CHAQUE ACTION SANS BOUTON
════════════════════════════════════════ */
function startSequence() {
  phase = 'mapping'; seqIdx = 0; waiting = false;
  holdPanel.style.display = 'none';
  show(listEl, false); show(graceBarWrap, true); show(actionsEl, true);
  show(gridEl, true); show(hintEl, true); show(cancelBtn, true);
  actionsEl.classList.remove('done', 'warn');
  hintEl.textContent = 'Un bouton ne peut avoir qu\'une seule fonction — vous pourrez en ajouter d\'autres ensuite';
  renderGrid();
  startGrace();
}

function startGrace() {
  waiting = false;
  graceBar.style.transition = 'none';
  graceBar.style.width      = '100%';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    graceBar.style.transition = 'width ' + GRACE_MS + 'ms linear';
    graceBar.style.width      = '0%';
  }));
  actionsEl.textContent = 'Prêt dans…';
  setTimeout(nextStep, GRACE_MS);
}

function promptStep() {
  actionsEl.classList.remove('warn');
  actionsEl.innerHTML = '🔘 Appuyez sur : <strong>' + seqList[seqIdx].label + '</strong>';
}

function nextStep() {
  if (seqIdx >= seqList.length) { enterRecap(true); return; }
  promptStep();
  graceBar.style.transition = 'none';
  graceBar.style.width      = '0%';
  waiting = true;
  renderGrid();
}

function receiveSeq(raw) {
  if (!waiting || cooldown) return;
  const act   = seqList[seqIdx];
  const owner = ownerOf(raw);
  if (owner) { flashReject(raw); showWarn('Déjà utilisé pour « ' + labelOf(owner) + ' » — choisissez un autre bouton'); return; }
  cooldown = true; waiting = false;
  setTimeout(() => { cooldown = false; }, COOLDOWN_MS);
  addBinding(raw, act.id);
  seqIdx++;
  renderGrid();
  actionsEl.textContent = '✓';
  setTimeout(nextStep, 200);
}

function renderGrid() {
  gridEl.innerHTML = '';
  const cur = seqList[seqIdx];
  ALL.forEach(a => {
    const b = bindsOf(a.id);
    const reject = flash && (b.indexOf(flash.raw) >= 0 || (cur && cur.id === a.id));
    const item = mk('div', 'mapper-btn' + (b.length ? ' assigned' : '') +
                           (cur && cur.id === a.id && waiting ? ' current-target' : '') +
                           (reject ? ' reject' : ''));
    item.appendChild(mk('span', null, a.label));
    if (b.length) item.appendChild(mk('span', 'mapper-key-name', pretty(b[0]) + (b.length > 1 ? ' +' + (b.length - 1) : '')));
    gridEl.appendChild(item);
  });
}

/* ════════════════════════════════════════
   PHASE 3 : RÉCAPITULATIF
════════════════════════════════════════ */
function recapItems() {
  const items = [];
  ALL.forEach(a => {
    const b = bindsOf(a.id);
    if (b.length) b.forEach(raw => items.push({ type: 'bind', raw: raw, action: a.id }));
    else items.push({ type: 'missing', action: a.id });
  });
  items.push({ type: 'add',      label: '＋ Ajouter un bouton' });
  items.push({ type: 'save',     label: '✓ Enregistrer' });
  items.push({ type: 'restart',  label: '⟲ Tout recommencer' });
  items.push({ type: 'cancel',   label: '✕ Quitter sans enregistrer' });
  return items;
}

function enterRecap(focusAdd) {
  phase = 'recap'; view = 'list';
  holdPanel.style.display = 'none';
  show(gridEl, false); show(graceBarWrap, false);
  show(listEl, true); show(actionsEl, true); show(hintEl, true); show(cancelBtn, false);
  actionsEl.classList.remove('done', 'warn');
  const items = recapItems();
  recapIdx = focusAdd ? items.findIndex(i => i.type === 'add') : 0;
  renderRecap(); recapStatus();
}

function recapStatus() {
  actionsEl.classList.remove('warn');
  if (capturing) {
    actionsEl.textContent = (capturing.action
      ? 'Bouton pour « ' + labelOf(capturing.action) + ' »'
      : 'Nouveau bouton') + ' — appuyez dessus (' + captureLeft + ' s)';
  } else if (view === 'picker') {
    actionsEl.textContent = 'Quelle action pour « ' + pretty(pendingFrom || pendingRaw) + ' » ?';
  } else if (view === 'menu') {
    actionsEl.textContent = 'Bouton « ' + pretty(menuRaw) + ' » — ' + labelOf(ownerOf(menuRaw));
  } else {
    const m = missing();
    actionsEl.textContent = m.length
      ? '⚠ Il manque un bouton pour : ' + m.map(a => a.label).join(', ')
      : 'Plusieurs boutons peuvent avoir la même action';
  }
}

function renderRecap() {
  listEl.innerHTML = '';
  if (view === 'menu')   { renderMenuView();   return; }
  if (view === 'picker') { renderPickerView(); return; }

  const items = recapItems();
  let section = null, focusNode = null;
  items.forEach((it, i) => {
    const sec = (it.type === 'bind' || it.type === 'missing') ? 'bind' : (it.type === 'add' ? 'add' : 'btn');
    if (sec !== section) {
      section = sec;
      listEl.appendChild(mk('div', 'mapper-sep', sec === 'bind' ? 'Action  ←  bouton' : ''));
    }
    const focused = i === recapIdx;
    let row;
    if (it.type === 'bind') {
      row = mk('div', 'mapper-row assigned' + (focused ? ' focused' : '') + (flash && flash.raw === it.raw ? ' reject' : ''));
      row.appendChild(mk('span', 'mapper-row-label', labelOf(it.action)));
      row.appendChild(mk('span', 'mapper-row-val', pretty(it.raw)));
      if (focused) hintEl.textContent = 'Confirmer = changer l\'action ou supprimer ce bouton';
    } else if (it.type === 'missing') {
      const isCap = capturing && capturing.action === it.action;
      row = mk('div', 'mapper-row missing' + (focused ? ' focused' : '') + (isCap ? ' capturing' : '') + (isCap && flash ? ' reject' : ''));
      row.appendChild(mk('span', 'mapper-row-label', labelOf(it.action)));
      row.appendChild(mk('span', 'mapper-row-val', isCap ? 'Appuyez…' : '— aucun bouton'));
      if (focused) hintEl.textContent = 'Confirmer, puis appuyez sur le bouton à associer';
    } else {
      const isCap = it.type === 'add' && capturing && !capturing.action;
      row = mk('div', 'mapper-row mapper-btnrow' + (focused ? ' focused' : '') + (isCap ? ' capturing' : '') + (isCap && flash ? ' reject' : ''),
               isCap ? 'Appuyez sur le nouveau bouton…' : it.label);
      if (focused) hintEl.textContent = {
        add:      'Appuyez sur le nouveau bouton, puis choisissez son action (ex. un joystick = la croix)',
        save:     'Enregistre le mappage',
        restart:  'Efface tous les boutons et recommence pas à pas',
        cancel:   'Retour = quitter sans enregistrer',
      }[it.type];
    }
    row.addEventListener('click', () => { recapIdx = i; view = 'list'; activate(it); });
    if (focused) focusNode = row;
    listEl.appendChild(row);
  });
  if (focusNode) focusNode.scrollIntoView({ block: 'nearest' });
}

/* ── Menu d'un bouton : changer l'action / supprimer ── */
function menuItems() {
  return [
    { id: 'change', label: '✏ Changer l\'action' },
    { id: 'delete', label: '✕ Supprimer ce bouton' },
    { id: 'back',   label: '← Retour' },
  ];
}
function renderMenuView() {
  listEl.appendChild(mk('div', 'mapper-sep', pretty(menuRaw) + '  →  ' + labelOf(ownerOf(menuRaw))));
  menuItems().forEach((it, i) => {
    const row = mk('div', 'mapper-row mapper-btnrow' + (i === subIdx ? ' focused' : ''), it.label);
    row.addEventListener('click', () => { subIdx = i; runMenu(it.id); });
    listEl.appendChild(row);
  });
  hintEl.textContent = '↑ ↓ choisir · Confirmer · Retour';
}
function runMenu(id) {
  if (id === 'change') {
    pendingFrom = menuRaw; pendingRaw = null; view = 'picker';
    subIdx = Math.max(0, ALL.findIndex(a => a.id === ownerOf(menuRaw)));
  } else if (id === 'delete') {
    if (!canRemove(menuRaw)) {
      showWarn('Il faut au moins un bouton pour « ' + labelOf(ownerOf(menuRaw)) + ' »');
      return;
    }
    removeBinding(menuRaw);
    view = 'list'; recapIdx = Math.max(0, Math.min(recapIdx, recapItems().length - 1));
  } else {
    view = 'list';
  }
  renderRecap(); recapStatus();
}

/* ── Choix de l'action d'un bouton (nouveau ou existant) ── */
function renderPickerView() {
  const raw = pendingFrom || pendingRaw;
  listEl.appendChild(mk('div', 'mapper-sep', 'Action du bouton « ' + pretty(raw) + ' »'));
  ALL.forEach((a, i) => {
    const row = mk('div', 'mapper-row' + (i === subIdx ? ' focused' : '') + (pendingFrom && ownerOf(pendingFrom) === a.id ? ' assigned' : ''));
    row.appendChild(mk('span', 'mapper-row-label', a.label));
    row.addEventListener('click', () => { subIdx = i; pickAction(a.id); });
    listEl.appendChild(row);
  });
  const focusNode = listEl.querySelector('.focused');
  if (focusNode) focusNode.scrollIntoView({ block: 'nearest' });
  hintEl.textContent = (ALL[subIdx].desc || '') + '  ·  Confirmer · Retour = annuler';
}
function pickAction(id) {
  let raw;
  if (pendingFrom) {
    raw = pendingFrom;
    const old = ownerOf(raw);
    if (old !== id) {
      if (!canRemove(raw)) { showWarn('Il faut au moins un bouton pour « ' + labelOf(old) + ' »'); return; }
      removeBinding(raw); addBinding(raw, id);
    }
  } else {
    raw = pendingRaw;
    addBinding(raw, id);
  }
  pendingFrom = pendingRaw = null;
  view = 'list';
  recapIdx = Math.max(0, recapItems().findIndex(i => i.type === 'bind' && i.raw === raw));
  renderRecap(); recapStatus();
}

/* ── Navigation par les boutons de l'appareil configuré ──
   Les boutons sont affichés deux par deux : gauche/droite changent de colonne,
   haut/bas changent de ligne ; les lignes d'action (Ajouter, Enregistrer...)
   restent en pleine largeur. */
function recapRaw(raw) {
  if (capturing) { captureRaw(raw); return; }
  const id = ownerOf(raw);
  if (!id) return;                       // bouton non mappé : ignoré

  if (view === 'list') {
    const items = recapItems();
    const g = items.filter(i => i.type === 'bind' || i.type === 'missing').length;   // taille de la grille
    if (id === 'confirm') { activate(items[recapIdx]); return; }
    if (id === 'back')    { goBack(); return; }
    if (recapIdx < g) {
      if      (id === 'left'  && recapIdx % 2 === 1)                 recapIdx--;
      else if (id === 'right' && recapIdx % 2 === 0 && recapIdx + 1 < g) recapIdx++;
      else if (id === 'up'    && recapIdx >= 2)                      recapIdx -= 2;
      else if (id === 'down')                                        recapIdx = recapIdx + 2 < g ? recapIdx + 2 : g;
      else return;
    } else {
      if      (id === 'up')   recapIdx = recapIdx === g ? g - 1 : recapIdx - 1;
      else if (id === 'down') recapIdx = Math.min(items.length - 1, recapIdx + 1);
      else return;
    }
    renderRecap();
    return;
  }

  if (id === 'back') { view = 'list'; pendingFrom = pendingRaw = null; renderRecap(); recapStatus(); return; }

  if (view === 'menu') {
    const n = menuItems().length;
    if      (id === 'up')      subIdx = Math.max(0, subIdx - 1);
    else if (id === 'down')    subIdx = Math.min(n - 1, subIdx + 1);
    else if (id === 'confirm') { runMenu(menuItems()[subIdx].id); return; }
    else return;
    renderRecap();
    return;
  }

  /* picker : grille 2 colonnes */
  const n = ALL.length;
  if      (id === 'left'  && subIdx % 2 === 1)           subIdx--;
  else if (id === 'right' && subIdx % 2 === 0 && subIdx + 1 < n) subIdx++;
  else if (id === 'up'    && subIdx >= 2)                subIdx -= 2;
  else if (id === 'down'  && subIdx + 2 < n)             subIdx += 2;
  else if (id === 'confirm') { pickAction(ALL[subIdx].id); return; }
  else return;
  renderRecap();
}

function activate(it) {
  if (!it || capturing) return;
  if (it.type === 'bind')          { menuRaw = it.raw; view = 'menu'; subIdx = 0; renderRecap(); recapStatus(); }
  else if (it.type === 'missing')  startCapture(it.action);
  else if (it.type === 'add')      startCapture(null);
  else if (it.type === 'save')     saveAndExit();
  else if (it.type === 'restart')  { working = {}; seqList = missing(); startSequence(); }
  else if (it.type === 'cancel')   goBack();
}

/* ── Capture d'un nouveau bouton ── */
function startCapture(action) {
  capturing    = { action: action };
  captureStart = Date.now();
  captureLeft  = Math.round(CAPTURE_MS / 1000);
  clearInterval(captureTimer);
  captureTimer = setInterval(() => {
    captureLeft--;
    if (captureLeft <= 0) stopCapture(); else recapStatus();
  }, 1000);
  renderRecap(); recapStatus();
}

function stopCapture() {
  clearInterval(captureTimer); captureTimer = null;
  capturing = null;
  renderRecap(); recapStatus();
}

function captureRaw(raw) {
  if (Date.now() - captureStart < CAPTURE_GRACE_MS) return;   // ignore l'appui qui vient d'ouvrir la capture
  const owner = ownerOf(raw);
  if (owner) {
    flashReject(raw);
    showWarn('Déjà utilisé pour « ' + labelOf(owner) + ' » — supprimez-le d\'abord ou choisissez-en un autre');
    return;
  }
  const target = capturing.action;
  clearInterval(captureTimer); captureTimer = null;
  capturing = null;
  if (target) {
    addBinding(raw, target);
    view = 'list';
    recapIdx = Math.max(0, recapItems().findIndex(i => i.type === 'bind' && i.raw === raw));
  } else {
    pendingRaw = raw; pendingFrom = null; view = 'picker'; subIdx = 0;   // reste à choisir l'action
  }
  renderRecap(); recapStatus();
}

/* Bouton refusé : met en rouge, un court instant, la boîte qui attend le bouton
   ET celle de l'action qui l'utilise déjà (re-rendu avec la classe 'reject'). */
function repaint() { if (phase === 'mapping') renderGrid(); else if (phase === 'recap') renderRecap(); }
function flashReject(raw) {
  flash = { raw: raw };
  clearTimeout(flashTimer);
  repaint();
  flashTimer = setTimeout(() => { flash = null; repaint(); }, 1100);
}

/* Message d'avertissement temporaire dans la zone d'état */
function showWarn(text) {
  actionsEl.classList.add('warn');
  actionsEl.textContent = '⚠ ' + text;
  clearTimeout(_warnTimer);
  _warnTimer = setTimeout(() => {
    actionsEl.classList.remove('warn');
    if (phase === 'mapping' && waiting) promptStep();
    else if (phase === 'recap') recapStatus();
  }, 2200);
}

/* ── Enregistrement ── */
function saveAndExit() {
  const m = missing();
  if (m.length) {
    showWarn('Il manque un bouton pour « ' + m[0].label + ' »');
    recapIdx = Math.max(0, recapItems().findIndex(i => i.type === 'missing'));
    renderRecap();
    return;
  }
  const map = cloneAssign(working);
  if (mapper.findConflicts(map).length) { showWarn('Un bouton est utilisé deux fois'); return; }
  mapper.save(selectedDeviceId, map, { kind: selectedKind });
  finish('Périphérique configuré !');
}

function finish(msg) {
  phase = 'done';
  clearInterval(captureTimer);
  actionsEl.classList.remove('warn');
  actionsEl.textContent = '✓ ' + msg;
  actionsEl.classList.add('done');
  toast.show(msg, false, 1500);
  setTimeout(goBack, 1300);
}

function goBack() {
  if (poller) poller.stop();
  if (window.xeLauncher?.offXeInputEvent) window.xeLauncher.offXeInputEvent();
  if (window.xeLauncher?.goBack) window.xeLauncher.goBack();
  else window.location.href = 'menu.html';
}
