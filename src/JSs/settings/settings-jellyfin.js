/**
 * settings-jellyfin.js
 * Onglet Jellyfin : mapping des touches JMP, liste des appareils configurés.
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.Jellyfin = (() => {

  /* ── Constantes ── */
  const JF_ACTIONS = [
    { id:'jf_up',    label:'↑ Haut',           key:'ArrowUp'    },
    { id:'jf_down',  label:'↓ Bas',            key:'ArrowDown'  },
    { id:'jf_left',  label:'← Gauche',         key:'ArrowLeft'  },
    { id:'jf_right', label:'→ Droite',          key:'ArrowRight' },
    { id:'jf_ok',    label:'OK / Entrée',       key:'Enter'      },
    { id:'jf_back',  label:'Retour',            key:'Escape'     },
    { id:'jf_menu',  label:'Menu Jellyfin',     key:'m'          },
    { id:'jf_prev',  label:'◀◀ Retour arrière', key:'j'          },
    { id:'jf_next',  label:'▶▶ Avancer',        key:'l'          },
  ];

  /* ── État ── */
  let jfMappingState   = {};
  let mappingActive    = false;
  let jfMappingIdx     = 0;
  let jfConfigExpanded = false;
  let jfButtonCount    = 5;

  /* ─────────────────────────────────────────────────────────────
     CHARGEMENT / SAUVEGARDE
  ───────────────────────────────────────────────────────────── */
  function loadMapping() {
    /* Structure: { deviceName: { jf_up: raw, __btncount: n }, ... } */
    try { jfMappingState = JSON.parse(localStorage.getItem('xelauncher_jf_mapping') || '{}'); } catch(e) { jfMappingState = {}; }
    /* jfButtonCount / jfMappingState sont chargés par appareil dans jmpmapper.js,
       ici on lit juste le nombre global pour l'affichage du statut */
    try { jfButtonCount = parseInt(localStorage.getItem('xelauncher_jf_btncount') || '5'); } catch(e) { jfButtonCount = 5; }
    if (jfButtonCount < 2) jfButtonCount = 2;
    if (jfButtonCount > 5) jfButtonCount = 5;
  }

  function saveMapping() {
    /* La sauvegarde par appareil est faite par jmpmapper.js.
       Ici on met juste à jour l'affichage après rechargement. */
    try { jfMappingState = JSON.parse(localStorage.getItem('xelauncher_jf_mapping') || '{}'); } catch(e) { jfMappingState = {}; }
    updateConfigStatus();
    renderSavedSummary();
  }

  /* ─────────────────────────────────────────────────────────────
     RENDU STATUT / RÉSUMÉ
  ───────────────────────────────────────────────────────────── */
  function updateConfigStatus() {
    const el = document.getElementById('jfConfigStatus');
    if (!el) return;
    const devices = Object.keys(jfMappingState).filter(k => !k.startsWith('__'));
    if (!devices.length) { el.textContent = 'Aucun appareil'; return; }
    el.textContent = devices.length + ' appareil' + (devices.length > 1 ? 's' : '') + ' configuré' + (devices.length > 1 ? 's' : '');
  }

  function renderSavedSummary() {
    /* Plus utilisé avec la nouvelle structure multi-appareils — masqué */
    const el = document.getElementById('jfSavedSummary');
    if (el) el.style.display = 'none';
  }

  function renderDeviceList() {
    const c = document.getElementById('jfDeviceList');
    if (!c) return;
    c.innerHTML = '';
    let allMaps = {};
    try { allMaps = JSON.parse(localStorage.getItem('xelauncher_jf_mapping') || '{}'); } catch(e) {}

    /* Nouvelle structure : { deviceName: { jf_up: raw, ... }, ... } */
    const devices = Object.keys(allMaps).filter(k => !k.startsWith('__') && typeof allMaps[k] === 'object');

    if (!devices.length) {
      c.innerHTML = '<div style="color:var(--text-dim);font-family:var(--font-mono);font-size:clamp(9px,1vw,11px);letter-spacing:2px;text-transform:uppercase;padding:10px 16px">Aucun appareil configuré</div>';
      updateContentFocus(); return;
    }

    devices.forEach(deviceName => {
      const devMap = allMaps[deviceName];
      const el = document.createElement('div');
      el.className = 'device-item';
      const label = deviceName === '__keyboard__'
        ? '⌨ Clavier'
        : (deviceName.length > 44 ? deviceName.slice(0, 44) + '…' : deviceName);
      const summary = JF_ACTIONS.filter(a => devMap[a.id]).map(a =>
        a.label + ': ' + (XeInput.prettyRaw(devMap[a.id]) || devMap[a.id])
      ).join(' · ');
      el.innerHTML =
        `<span class="device-icon">🎬</span>` +
        `<div style="flex:1"><div class="device-name">${label}</div>` +
        (summary ? `<div style="font-size:clamp(8px,0.85vw,10px);color:var(--text-hint);letter-spacing:1px;margin-top:3px">${summary}</div>` : '') +
        `</div>` +
        `<span style="font-size:clamp(9px,1vw,11px);color:rgba(0,164,220,0.6);letter-spacing:1px">configuré</span>`;
      el.addEventListener('click', () => {
        sessionStorage.setItem('jmpmap_deviceId', deviceName);
        window.location.href = 'JMPmapper.html';
      });
      c.appendChild(el);
    });
    updateContentFocus();
  }

  function renderJfMapping() {
    updateConfigStatus();
    const grid = document.getElementById('jfMappingGrid');
    if (!grid || !jfConfigExpanded) return;
    const total = 4 + jfButtonCount;
    grid.innerHTML = '';
    JF_ACTIONS.slice(0, total).forEach((a, i) => {
      const btn = document.createElement('div');
      btn.className = 'jf-key-btn' + (jfMappingState[a.id] ? ' mapped' : '');
      if (mappingActive && jfMappingIdx === i) btn.classList.add('waiting');
      btn.innerHTML =
        `<span>${a.label}</span>` +
        (jfMappingState[a.id] ? `<span class="jf-key-name">${jfMappingState[a.id]}</span>` : '');
      btn.addEventListener('click', () => startMappingAt(i));
      grid.appendChild(btn);
    });
    const countRow = document.createElement('div');
    countRow.style.cssText = 'grid-column:span 2;display:flex;gap:8px;padding:8px 0;align-items:center';
    countRow.innerHTML = '<span style="font-family:var(--font-mono);font-size:clamp(8px,0.9vw,10px);letter-spacing:2px;color:var(--text-hint);text-transform:uppercase">Boutons (hors croix) :</span>';
    [2,3,4,5].forEach(n => {
      const b = document.createElement('button');
      b.className = 'option-item' + (n === jfButtonCount ? ' selected' : '');
      b.textContent = n;
      b.addEventListener('click', () => { jfButtonCount = n; saveMapping(); renderJfMapping(); });
      countRow.appendChild(b);
    });
    grid.appendChild(countRow);
    const mapAll = document.createElement('div');
    mapAll.className      = 'jf-key-btn';
    mapAll.style.gridColumn = 'span 2';
    mapAll.innerHTML      = '<span>▶ Tout remapper dans l\'ordre</span>';
    mapAll.addEventListener('click', () => startMappingAt(0));
    grid.appendChild(mapAll);
    const reset = document.createElement('div');
    reset.className       = 'jf-key-btn';
    reset.style.gridColumn = 'span 2';
    reset.innerHTML       = '<span>✕ Réinitialiser le mapping Jellyfin</span>';
    reset.addEventListener('click', () => { jfMappingState = {}; saveMapping(); renderJfMapping(); toast.show('Mapping Jellyfin réinitialisé', false); });
    grid.appendChild(reset);
    updateContentFocus();
  }

  function startMappingAt(startIdx) {
    mappingActive  = true;
    jfMappingIdx   = startIdx;
    screen = 'jf-mapping';
    renderJfMapping();
  }

  function handleMappingKey(rawKey) {
    const total = 4 + jfButtonCount;
    if (!mappingActive || jfMappingIdx >= total) return;
    if (rawKey !== 'Escape') {
      jfMappingState[JF_ACTIONS[jfMappingIdx].id] = rawKey;
    }
    jfMappingIdx++;
    if (jfMappingIdx >= total) {
      mappingActive = false;
      screen = 'main';
      saveMapping();
      toast.show('Mapping Jellyfin enregistré', false);
    }
    renderJfMapping();
  }

  /* ── API publique ── */
  return {
    get mappingActive() { return mappingActive; },

    loadMapping, saveMapping,
    updateConfigStatus, renderSavedSummary, renderDeviceList, renderJfMapping,
    startMappingAt, handleMappingKey,
  };
})();
