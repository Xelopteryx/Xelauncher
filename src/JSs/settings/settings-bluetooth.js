/**
 * settings-bluetooth.js
 * Onglet Bluetooth.
 *
 * Nouveau flux « Ajouter un appareil » :
 *   1. Choix du type (casque/enceinte, manette, Wiimote, clavier/souris, autre)
 *   2. Recherche en direct : les appareils s'affichent dès qu'ils sont
 *      identifiés, filtrés par type (les autres restent accessibles)
 *   3. Appairage adapté au type :
 *        audio       -> pair+trust+connect, puis bascule de la sortie audio
 *        controller  -> pair+trust+connect, puis configuration des touches
 *        wiimote     -> flux Wiimote dédié, puis configuration des touches
 *        keyboard    -> pair+trust+connect (code affiché si demandé)
 *
 * Tout le texte venant des appareils est inséré via textContent (jamais
 * innerHTML) : les noms Bluetooth sont contrôlés par l'appareil.
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.Bluetooth = (() => {

  const BT_TYPES = [
    { id: 'audio',      icon: '🎧', logo: 'casque.png',  label: 'Audio',      
      desc: 'Tout ce qui peut diffuser du son : casque, écouteurs, enceinte, barre de son…',
      hint: 'Mettez-le en mode appairage' },
    { id: 'controller', icon: '🎮', logo: 'manette.png', label: 'Contrôleurs',
      desc: 'Tout ce qui permet de naviguer et d\u2019interagir dans les menus : manette de jeu, télécommande…',
      hint: 'Mettez-la en mode appairage' },
    { id: 'other',      icon: '📡', logo: 'autre.png',   label: 'Autre',      
      desc: 'Tout ce qui ne correspond pas aux deux autres catégories.',
      hint: 'Mettez-le en mode appairage' },
  ];
  const TYPE_ICON  = { audio: '🎧', controller: '🎮', wiimote: '🕹', keyboard: '⌨️', other: '📡' };
  const TYPE_LABEL = { audio: 'Audio', controller: 'Manette', wiimote: 'Wiimote', keyboard: 'Clavier/Souris', other: 'Autre' };

  /* ── État : liste principale ── */
  let btPowered            = false;
  let btPaired             = [];
  let hiddenBtDevices      = [];
  let hiddenBtNames        = {};   // MAC -> nom (pour afficher un appareil masqué même non appairé)
  let btHiddenListExpanded = false;

  /* ── État : overlay d'actions ── */
  let btActionDev      = null;
  let btActionItems    = [];
  let btActionFocusIdx = 0;

  /* ── État : overlay d'ajout ── */
  let scanStep    = 'type';   // 'type' | 'scan'
  let typeIdx     = 0;
  let selType     = 'audio';  // 'audio' | 'controller' | 'other'
  let found       = [];       // appareils vus pendant la recherche
  let scanning    = false;
  let showOthers  = false;    // afficher aussi les appareils d'un autre type
  let focusKey    = null;     // 'dev:MAC' | 'act:xxx' — suit l'élément, pas l'index
  let userMoved   = false;    // tant que faux, le focus suit le 1er élément de la liste
  let scanItems   = [];
  let renderQueued = false;
  let scanStartedAt = 0;
  let quickRestarts = 0;      // relances trop rapides d'affilée (évite de boucler sur une erreur)

  /* Icône d'un appareil : image du dossier LOGOs (les emojis s'affichaient
     comme un rectangle vertical quand la police emoji est absente du système). */
  const TYPE_LOGO = { audio: 'casque.png', controller: 'manette.png', wiimote: 'manette.png', keyboard: 'autre.png', other: 'autre.png' };
  function _typeIcon(type, cls, style) {
    const wrap = document.createElement('span');
    wrap.className = cls + ' bt-icon-wrap';
    if (style) wrap.style.cssText = style;
    const img = document.createElement('img');
    img.src       = '../LOGOs/' + (TYPE_LOGO[type] || TYPE_LOGO.other);
    img.alt       = '';
    img.draggable = false;
    img.onerror   = () => img.remove();
    wrap.appendChild(img);
    return wrap;
  }

  /* ── Petits helpers ── */
  function _el(tag, cls, text, style) {
    const e = document.createElement(tag);
    if (cls)  e.className = cls;
    if (text != null) e.textContent = text;
    if (style) e.style.cssText = style;
    return e;
  }
  function _toast(msg, isError) { if (typeof toast !== 'undefined' && toast) toast.show(msg, !!isError); }
  function _isBack(k) { return k === 'Escape' || k === 'Backspace' || k === 'Back'; }
  function _setBusy(text) {
    const lt = document.getElementById('loadingText');
    const lo = document.getElementById('loadingOverlay');
    if (lt) lt.textContent = text;
    if (lo) lo.classList.add('visible');
  }
  function _clearBusy() {
    const lo = document.getElementById('loadingOverlay');
    if (lo) lo.classList.remove('visible');
  }
  function _emptyMsg(text) {
    return _el('div', 'bt-empty', text);
  }

  /* ─────────────────────────────────────────────────────────────
     APPAREILS MASQUÉS
  ───────────────────────────────────────────────────────────── */
  function loadHiddenDevices() {
    try { hiddenBtDevices = JSON.parse(localStorage.getItem('xelauncher_hidden_bt') || '[]'); } catch (e) { hiddenBtDevices = []; }
    try { hiddenBtNames   = JSON.parse(localStorage.getItem('xelauncher_hidden_bt_names') || '{}'); } catch (e) { hiddenBtNames = {}; }
    _updateHiddenCount();
  }
  function saveHiddenDevices() {
    localStorage.setItem('xelauncher_hidden_bt', JSON.stringify(hiddenBtDevices));
    localStorage.setItem('xelauncher_hidden_bt_names', JSON.stringify(hiddenBtNames));
    _updateHiddenCount();
  }
  function _rememberHidden(mac, name) {
    if (!hiddenBtDevices.includes(mac)) hiddenBtDevices.push(mac);
    if (name) hiddenBtNames[mac] = name;
  }
  function _updateHiddenCount() {
    const el = document.getElementById('hiddenBtCount');
    if (el) el.textContent = hiddenBtDevices.length;
  }

  function toggleHiddenList() {
    btHiddenListExpanded = !btHiddenListExpanded;
    const hl = document.getElementById('hiddenBtList');
    if (!hl) return;
    hl.style.display = btHiddenListExpanded ? 'block' : 'none';
    /* Replié : on vide la liste, sinon ses lignes restaient dans la
       navigation clavier alors qu'elles n'étaient plus visibles. */
    if (btHiddenListExpanded) renderHiddenBtList(); else hl.innerHTML = '';
    updateContentFocus();
  }

  function hideDevice(rowEl, idx) {
    const mac = rowEl.dataset.mac;
    if (!mac) return;
    _rememberHidden(mac, rowEl.querySelector('.bt-name')?.textContent);
    saveHiddenDevices();
    renderBtPaired();
    if (btHiddenListExpanded) renderHiddenBtList();
    rowFocusMap['bluetooth'] = Math.max(0, Math.min(idx, getContentRows().length - 1));
    updateContentFocus();
  }

  function unhideDevice(mac) {
    const i = hiddenBtDevices.indexOf(mac);
    if (i >= 0) hiddenBtDevices.splice(i, 1);
    delete hiddenBtNames[mac];
    saveHiddenDevices();
    renderBtPaired();
    renderHiddenBtList();
    rowFocusMap['bluetooth'] = Math.max(0, Math.min(rowFocusMap['bluetooth'], getContentRows().length - 1));
    updateContentFocus();
    _toast('Appareil démasqué', false);
  }

  /* ─────────────────────────────────────────────────────────────
     CHARGEMENT / ALIMENTATION
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
    window.xeLauncher.btPower(btPowered).then(() => { if (btPowered) load(); });
    const tog = rowEl.querySelector('.toggle');
    if (tog) tog.className = 'toggle' + (btPowered ? ' on' : '');
    _toast(btPowered ? 'Bluetooth activé' : 'Bluetooth désactivé', false);
  }

  /* ─────────────────────────────────────────────────────────────
     LISTE DES APPAREILS APPAIRÉS
  ───────────────────────────────────────────────────────────── */
  function renderBtPaired() {
    const c = document.getElementById('btPairedList');
    if (!c) return;
    c.innerHTML = '';
    const visible = btPaired.filter(d => !hiddenBtDevices.includes(d.mac));
    if (!visible.length) {
      c.appendChild(_emptyMsg('Aucun appareil appairé'));
    }
    visible.forEach(dev => {
      const el = _el('div', 'bt-item');
      el.dataset.mac    = dev.mac;
      el.dataset.bttype = 'paired';
      el.appendChild(_typeIcon(dev.type, 'bt-icon'));
      el.appendChild(_el('span', 'bt-name', dev.name || dev.mac));
      if (dev.connected) el.appendChild(_el('span', 'bt-connected', '● connecté'));
      el.appendChild(_el('span', 'bt-mac', dev.mac));
      el.addEventListener('click', () => openActionOverlay(dev, true));
      c.appendChild(el);
    });
    _updateHiddenCount();
    if (btHiddenListExpanded) renderHiddenBtList();
    updateContentFocus();
  }

  function renderHiddenBtList() {
    const c = document.getElementById('hiddenBtList');
    if (!c) return;
    c.innerHTML = '';
    if (!hiddenBtDevices.length) {
      c.appendChild(_emptyMsg('Aucun appareil masqué'));
      updateContentFocus();
      return;
    }
    hiddenBtDevices.forEach(mac => {
      const dev = btPaired.find(d => d.mac === mac);
      const el  = _el('div', 'bt-item bt-item-hidden');
      el.dataset.mac      = mac;
      el.dataset.btHidden = '1';
      el.appendChild(_typeIcon(dev ? dev.type : 'other', 'bt-icon', 'opacity:0.5'));
      el.appendChild(_el('span', 'bt-name', (dev && dev.name) || hiddenBtNames[mac] || mac, 'opacity:0.5'));
      el.appendChild(_el('span', 'bt-mac', mac));
      el.appendChild(_el('span', '', '→ démasquer',
        'font-size:clamp(10px,1.1vw,13px);color:rgba(0,164,220,0.7);letter-spacing:1px;margin-left:8px'));
      el.addEventListener('click', () => unhideDevice(mac));
      c.appendChild(el);
    });
    updateContentFocus();
  }

  /* ─────────────────────────────────────────────────────────────
     AJOUT D'UN APPAREIL — OVERLAY (type -> recherche en direct)
  ───────────────────────────────────────────────────────────── */
  function doScan() {            // appelé par settings-core (action "bt-scan")
    if (!window.xeLauncher) { _toast('API non disponible', true); return; }
    const ov = document.getElementById('btScanOverlay');
    if (!ov) { _toast('btScanOverlay manquant dans settings.html', true); return; }

    /* On rend d'abord, on ne passe en écran 'btScan' qu'ensuite : si le rendu
       plante, la navigation n'est pas bloquée sur un écran invisible. */
    const open = () => {
      scanStep = 'type';
      typeIdx  = 0;
      found    = [];
      scanning = false;
      _renderScan();
      ov.classList.add('visible');
      screen = 'btScan';
      updateContentFocus();
    };

    if (btPowered) { open(); return; }

    /* Bluetooth coupé (ou état pas encore chargé) : on vérifie et on
       l'allume au lieu de refuser sans rien dire. */
    screen = 'btBusy';
    window.xeLauncher.btStatus().then(s => {
      if (s && s.powered) return true;
      _setBusy('Activation du Bluetooth…');
      return window.xeLauncher.btPower(true);
    }).then(ok => {
      _clearBusy();
      screen = 'main';
      if (!ok) { _toast("Impossible d'activer le Bluetooth", true); return; }
      btPowered = true;
      const tog = document.getElementById('btToggle');
      if (tog) tog.className = 'toggle on';
      open();
    }).catch(() => { _clearBusy(); screen = 'main'; _toast('Erreur Bluetooth', true); });
  }

  function _stopRemote() {
    if (!window.xeLauncher) return;
    window.xeLauncher.btScanStop();
    if (window.xeLauncher.offBtScan) window.xeLauncher.offBtScan();
  }

  function closeScanOverlay() {
    _stopRemote();
    scanning = false;
    document.getElementById('btScanOverlay').classList.remove('visible');
    screen = 'main';
    updateContentFocus();
  }

  function _backToType() {
    _stopRemote();
    scanning = false;
    scanStep = 'type';
    found    = [];
    _renderScan();
  }

  function _startScan(typeId) {
    selType       = typeId;
    scanStep      = 'scan';
    found         = [];
    showOthers    = false;
    focusKey      = null;
    userMoved     = false;
    quickRestarts = 0;
    _launchScan();
    _renderScan();
  }

  /** (Re)lance la recherche BlueZ sans toucher à la liste déjà trouvée. */
  function _launchScan() {
    scanning      = true;
    scanStartedAt = Date.now();
    window.xeLauncher.onBtScanDevice(_onScanDevice);
    window.xeLauncher.onBtScanDone(_onScanDone);
    window.xeLauncher.btScanStart();
  }

  /** La recherche ne s'arrête que si l'utilisateur choisit un appareil ou quitte le menu. */
  function _onScanDone(p) {
    if (screen !== 'btScan' || scanStep !== 'scan') return;
    if (p && p.error) {
      scanning = false;
      _toast('Recherche Bluetooth impossible : ' + p.error, true);
      _scheduleRender();
      return;
    }
    quickRestarts = (Date.now() - scanStartedAt < 3000) ? quickRestarts + 1 : 0;
    if (quickRestarts >= 3) { scanning = false; _scheduleRender(); return; }   // boucle suspecte : on s'arrête
    setTimeout(() => { if (screen === 'btScan' && scanStep === 'scan') _launchScan(); }, 300);
  }

  function _onScanDevice(d) {
    const i = found.findIndex(x => x.mac === d.mac);
    if (i >= 0) found[i] = { ...found[i], ...d }; else found.push(d);
    _scheduleRender();
  }

  function _scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      if (screen === 'btScan' && scanStep === 'scan') _renderScan();
    });
  }

  /** Un appareil appartient-il à la catégorie choisie ? */
  function _inCategory(d, cat) {
    const controller = d.type === 'controller' || d.type === 'wiimote';
    if (cat === 'audio')      return d.type === 'audio';
    if (cat === 'controller') return controller;
    return d.type !== 'audio' && !controller;           // 'other'
  }

  function _buildScanItems() {
    /* Les appareils déjà appairés et les appareils masqués n'apparaissent pas. */
    const pairedMacs = new Set(btPaired.map(p => p.mac));
    const vis      = found.filter(d => !d.paired && !pairedMacs.has(d.mac) && !hiddenBtDevices.includes(d.mac));
    const matching = vis.filter(d => _inCategory(d, selType));
    const others   = vis.filter(d => !_inCategory(d, selType));
    const list     = showOthers ? [...matching, ...others] : matching;

    const items = list.map(d => ({ key: 'dev:' + d.mac, kind: 'dev', dev: d }));
    if (others.length) items.push({ key: 'act:others', kind: 'others', count: others.length });
    if (!scanning)     items.push({ key: 'act:rescan', kind: 'rescan' });   // seulement si la recherche s'est interrompue
    items.push({ key: 'act:back', kind: 'back' });
    return items;
  }

  function _signalBars(rssi) {
    const lit = rssi == null ? 0 : rssi > -55 ? 4 : rssi > -65 ? 3 : rssi > -75 ? 2 : 1;
    const wrap = _el('span', 'wifi-signal bt-scan-signal');
    for (let b = 1; b <= 4; b++) wrap.appendChild(_el('span', 'bar' + (b <= lit ? ' lit' : '')));
    return wrap;
  }

  function _renderScan() {
    const ov = document.getElementById('btScanOverlay');
    if (!ov) return;
    ov.innerHTML = '';

    /* ── Étape 1 : choix du type (3 carrés, centrés à l'écran) ── */
    if (scanStep === 'type') {
      const screenEl = _el('div', 'bt-type-screen');

      const top = _el('div', 'bt-type-top');
      top.appendChild(_el('div', 'iface-overlay-title', 'Ajouter un appareil'));
      top.appendChild(_el('div', 'iface-overlay-hint', '← → Choisir  •  Entrée Valider  •  Retour Fermer'));
      screenEl.appendChild(top);

      const cards = _el('div', 'bt-type-cards');
      BT_TYPES.forEach((t, i) => {
        const card = _el('div', 'bt-type-card' + (i === typeIdx ? ' focused' : ''));
        card.title = t.label;
        const img = document.createElement('img');
        img.className = 'bt-type-img';
        img.src       = '../LOGOs/' + t.logo;
        img.alt       = t.label;
        img.draggable = false;
        img.onerror   = () => img.replaceWith(_el('span', 'bt-type-fallback', t.icon));
        card.appendChild(img);
        card.addEventListener('click', () => { typeIdx = i; _startScan(t.id); });
        cards.appendChild(card);
      });
      screenEl.appendChild(cards);

      /* Nom + exemples sous chaque carré, description du type sélectionné en dessous */
      const info   = _el('div', 'bt-type-info');
      const labels = _el('div', 'bt-type-labels');
      BT_TYPES.forEach((t, i) => {
        const l = _el('div', 'bt-type-label' + (i === typeIdx ? ' focused' : ''));
        l.appendChild(_el('div', 'bt-type-name', t.label));
        labels.appendChild(l);
      });
      info.appendChild(labels);
      info.appendChild(_el('div', 'bt-type-desc', BT_TYPES[typeIdx].desc));
      screenEl.appendChild(info);

      ov.appendChild(screenEl);
      return;
    }

    /* ── Étape 2 : recherche en direct ── */
    const typeDef = BT_TYPES.find(t => t.id === selType) || BT_TYPES[BT_TYPES.length - 1];
    scanItems = _buildScanItems();
    if (!userMoved || !scanItems.some(i => i.key === focusKey)) focusKey = scanItems[0].key;

    ov.appendChild(_el('div', 'iface-overlay-title', typeDef.label));

    const status = _el('div', 'bt-scan-status');
    status.appendChild(_el('span', 'bt-scan-dot' + (scanning ? ' live' : '')));
    status.appendChild(_el('span', '',
      (scanning ? 'Recherche en cours…' : 'Recherche interrompue') +
      (scanning && typeDef.hint ? '  •  ' + typeDef.hint : '')));
    ov.appendChild(status);
    ov.appendChild(_el('div', 'iface-overlay-hint',
      '↑ ↓ Naviguer  •  Entrée Appairer  •  → Masquer  •  Retour Changer de type'));

    const list = _el('div', 'bt-scan-list');
    if (!scanItems.some(i => i.kind === 'dev')) {
      list.appendChild(_el('div', 'bt-empty', scanning ? 'Aucun appareil pour le moment…' : 'Aucun appareil trouvé'));
    }

    const firstAction = scanItems.findIndex(i => i.kind !== 'dev');
    scanItems.forEach((item, idx) => {
      const focused = item.key === focusKey;
      const row = _el('div', 'bt-scan-row' + (focused ? ' focused' : '') +
        (item.kind !== 'dev' ? ' is-action' : '') + (idx === firstAction ? ' first-action' : ''));

      if (item.kind === 'dev') {
        const d = item.dev;
        const left = _el('div', 'bt-scan-left');
        left.appendChild(_signalBars(d.rssi));
        left.appendChild(_typeIcon(d.type, 'bt-scan-icon'));
        /* Nom sur plusieurs lignes si besoin + adresse en dessous : de quoi
           reconnaître l'appareil même quand son nom est long ou générique. */
        const txt = _el('div', 'bt-scan-text');
        txt.appendChild(_el('span', 'bt-scan-name', d.name));
        const mismatch = !_inCategory(d, selType);
        txt.appendChild(_el('span', 'bt-scan-sub', (mismatch ? (TYPE_LABEL[d.type] || 'Autre') + '  ·  ' : '') + d.mac));
        left.appendChild(txt);
        row.appendChild(left);
        row.addEventListener('click', () => _pickDevice(d));
      } else {
        const labels = {
          others: showOthers ? 'Masquer les autres types' : 'Afficher les autres appareils (' + item.count + ')',
          rescan: '↻ Relancer la recherche',
          back:   '← Changer de type',
        };
        row.textContent = labels[item.kind];
        row.addEventListener('click', () => _activateAction(item.kind));
      }
      list.appendChild(row);
    });
    ov.appendChild(list);

    const f = ov.querySelector('.focused');
    if (f) f.scrollIntoView({ block: 'nearest' });
  }

  function _activateAction(kind) {
    if (kind === 'others') { showOthers = !showOthers; _renderScan(); }
    else if (kind === 'rescan') { _startScan(selType); }
    else if (kind === 'back')   { _backToType(); }
  }

  /** Masque un appareil trouvé pendant la recherche. */
  function _hideScanned(dev, idx) {
    _rememberHidden(dev.mac, dev.name);
    saveHiddenDevices();
    if (btHiddenListExpanded) renderHiddenBtList();
    scanItems = _buildScanItems();
    focusKey  = scanItems[Math.min(idx, scanItems.length - 1)].key;
    userMoved = true;
    _renderScan();
    _toast('Appareil masqué : ' + (dev.name || dev.mac), false);
  }

  /** Navigation clavier / manette dans l'overlay d'ajout. */
  function scanKey(key) {
    if (key === 'Triangle') key = 'Enter';

    if (scanStep === 'type') {
      if      (key === 'ArrowLeft')  typeIdx = Math.max(0, typeIdx - 1);
      else if (key === 'ArrowRight') typeIdx = Math.min(BT_TYPES.length - 1, typeIdx + 1);
      else if (key === 'Enter')     { _startScan(BT_TYPES[typeIdx].id); return; }
      else if (_isBack(key))        { closeScanOverlay(); return; }
      else return;
      _renderScan();
      return;
    }

    const idx = Math.max(0, scanItems.findIndex(i => i.key === focusKey));
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const next = Math.max(0, Math.min(scanItems.length - 1, idx + (key === 'ArrowUp' ? -1 : 1)));
      focusKey  = scanItems[next].key;
      userMoved = true;
      _renderScan();
    } else if (key === 'ArrowRight') {
      const it = scanItems[idx];
      if (it && it.kind === 'dev') _hideScanned(it.dev, idx);
    } else if (key === 'Enter') {
      const it = scanItems[idx];
      if (!it) return;
      if (it.kind === 'dev') _pickDevice(it.dev); else _activateAction(it.kind);
    } else if (_isBack(key)) {
      _backToType();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     APPAIRAGE / CONNEXION D'UN APPAREIL CHOISI
  ───────────────────────────────────────────────────────────── */
  function _resolveType(dev) {
    if (dev.type && dev.type !== 'other') return dev.type;
    return selType !== 'any' ? selType : 'other';
  }

  function _pickDevice(dev) {
    const type = _resolveType(dev);
    closeScanOverlay();
    screen = 'btBusy';
    updateContentFocus();
    if (dev.paired) _runConnect(dev, type); else _runPair(dev, type);
  }

  function _endBusy() {
    window.xeLauncher.offBtPairProgress();
    _clearBusy();
    if (screen === 'btBusy') screen = 'main';
    load();
    updateContentFocus();
  }

  function _runPair(dev, type) {
    const name = dev.name || dev.mac;
    _setBusy('Appairage de ' + name + '…');
    window.xeLauncher.onBtPairProgress(p => {
      if      (p.stage === 'passkey') _setBusy('Tapez ' + p.code + ' sur ' + name + ', puis Entrée');
      else if (p.stage === 'connect') _setBusy('Connexion à ' + name + '…');
    });

    /* Les messages sont affichés APRÈS la fermeture de l'écran d'attente
       (sinon le toast passait derrière lui et n'était jamais vu). */
    const report = (msg, isError, after) => {
      _endBusy();
      _toast(msg, isError);
      if (after) after();
    };

    window.xeLauncher.btPair(dev.mac, type).then(res => {
      res = res || {};
      if (!res.ok) {
        return report('Échec appairage' + (res.error ? ' — ' + res.error : ''), true);
      }
      if (_isInputType(type)) return _finishInput(dev, type, true);
      if (res.connected) {
        return report('● Bluetooth connecté : ' + name, false, () => _afterConnected(dev, type, true));
      }
      /* Appairé mais pas connecté : les casques ont souvent besoin d'une 2e tentative. */
      _setBusy('Connexion à ' + name + '…');
      return window.xeLauncher.btConnect(dev.mac).then(ok => {
        if (ok) return report('● Bluetooth connecté : ' + name, false, () => _afterConnected(dev, type, true));
        return _diagnose(dev, type).then(cause =>
          report('Appairé, mais connexion impossible — ' + (cause || res.error || 'réessayez depuis la liste'), true));
      });
    }).catch(() => report('Erreur Bluetooth', true));
  }

  function _runConnect(dev, type) {
    const name = dev.name || dev.mac;
    if (_isInputType(type)) { _finishInput(dev, type, false).catch(() => { _endBusy(); _toast('Erreur Bluetooth', true); }); return; }
    _setBusy('Connexion à ' + name + '…');
    window.xeLauncher.btConnect(dev.mac).then(ok => {
      if (ok) {
        _endBusy();
        _toast('● Bluetooth connecté : ' + name, false);
        _afterConnected(dev, type, false);
        return;
      }
      return _diagnose(dev, type).then(cause => {
        _endBusy();
        _toast('Échec de connexion à ' + name + (cause ? ' — ' + cause : ''), true);
      });
    }).catch(() => { _endBusy(); _toast('Erreur Bluetooth', true); });
  }

  /** Cause probable d'un échec de connexion (texte vide si rien trouvé). */
  function _diagnose(dev, type) {
    if (!window.xeLauncher?.btDiagnose) return Promise.resolve('');
    return window.xeLauncher.btDiagnose(dev.mac, type || dev.type || 'audio')
      .then(r => (r && r.problems && r.problems[0]) || '')
      .catch(() => '');
  }

  const _isInputType = t => t === 'controller' || t === 'wiimote';

  function _openMapper() {
    setTimeout(() => {
      sessionStorage.removeItem('mapper_deviceId');
      window.location.href = 'mapper.html';
    }, 1200);
  }

  /**
   * Manette / Wiimote : « Connected: yes » ne prouve rien (elle peut se couper
   * aussitôt, ou ne jamais être vue par le système). On attend donc que le
   * noyau crée réellement son périphérique d'entrée. Beaucoup de manettes ne
   * se connectent que si on appuie sur leur bouton Accueil / PS / Guide.
   */
  function _finishInput(dev, type, isNew) {
    const name = dev.name || dev.mac;
    _setBusy(name + ' — appuyez sur son bouton Accueil / PS / Guide…');
    /* Tentative de connexion en parallèle ; son échec n'est pas bloquant. */
    window.xeLauncher.btConnect(dev.mac).catch(() => {});
    return window.xeLauncher.btInputReady(dev.mac, 15000).then(ready => {
      if (ready) {
        _endBusy();
        _toast('● Manette connectée : ' + name, false);
        if (isNew) _openMapper();
        return;
      }
      return _diagnose(dev, type).then(cause => {
        _endBusy();
        _toast(name + ' : appairée mais non détectée par le système — ' +
               (cause || 'appuyez sur son bouton Accueil puis réessayez depuis la liste'), true);
      });
    });
  }

  /** Suite logique selon le type. isNew : appareil tout juste appairé. */
  function _afterConnected(dev, type, isNew) {
    if (type === 'audio') {
      if (XeSettings.Audio && XeSettings.Audio.selectSinkForDevice) XeSettings.Audio.selectSinkForDevice(dev.mac);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     OVERLAY D'ACTIONS (appareils appairés)
  ───────────────────────────────────────────────────────────── */
  function openActionOverlay(dev, isPaired) {
    btActionDev   = { ...dev, paired: isPaired };
    btActionItems = [];
    if (isPaired) {
      btActionItems.push(dev.connected
        ? { label: '⏏  Déconnecter', action: 'disconnect' }
        : { label: '⚡  Connecter',   action: 'connect'    });
      if (dev.connected && dev.type === 'audio')
        btActionItems.push({ label: '🔊  Utiliser comme sortie audio', action: 'use-audio' });
      if (dev.connected && (dev.type === 'controller' || dev.type === 'wiimote'))
        btActionItems.push({ label: '🎮  Configurer les touches', action: 'map' });
      btActionItems.push({ label: '✏  Renommer',            action: 'rename' });
      btActionItems.push({ label: "✕  Retirer l'appairage", action: 'remove', danger: true });
    }
    btActionItems.push({ label: '⊘  Masquer', action: 'hide' });
    btActionFocusIdx = 0;
    screen = 'btAction';
    renderActionOverlay();
    document.getElementById('btActionOverlay').classList.add('visible');
    updateContentFocus();
  }

  function closeActionOverlay() {
    btActionDev = null;
    screen = 'main';
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
      const btn = _el('div', 'bt-action-btn' + (item.danger ? ' danger' : '') + (i === btActionFocusIdx ? ' focused' : ''), item.label);
      btn.addEventListener('click', () => { btActionFocusIdx = i; executeAction(item.action); });
      list.appendChild(btn);
    });
  }

  function executeAction(action) {
    const dev = btActionDev;
    if (!dev || !window.xeLauncher) return;
    const name = dev.name || dev.mac;

    if (action === 'hide') {
      _rememberHidden(dev.mac, dev.name);
      saveHiddenDevices();
      closeActionOverlay();
      renderBtPaired();
      return;
    }

    closeActionOverlay();

    if (action === 'connect') {
      screen = 'btBusy';
      updateContentFocus();
      _runConnect(dev, dev.type || 'other');
    } else if (action === 'disconnect') {
      window.xeLauncher.btDisconnect(dev.mac).then(() => {
        _toast('Déconnecté : ' + name, false);
        load();
      });
    } else if (action === 'use-audio') {
      if (XeSettings.Audio && XeSettings.Audio.selectSinkForDevice) XeSettings.Audio.selectSinkForDevice(dev.mac);
    } else if (action === 'map') {
      sessionStorage.removeItem('mapper_deviceId');
      window.location.href = 'mapper.html';
    } else if (action === 'remove') {
      screen = 'btBusy';
      updateContentFocus();
      _setBusy('Suppression de ' + name + '…');
      window.xeLauncher.btRemove(dev.mac).then(ok => {
        _toast(ok ? 'Appairage supprimé' : 'Erreur', !ok);
      }).finally(() => { _clearBusy(); screen = 'main'; load(); });
    } else if (action === 'rename') {
      openKb('Nouveau nom — ' + name, dev.name || '', (val) => {
        if (!val) return;
        window.xeLauncher.btRename(dev.mac, val).then(ok => {
          _toast(ok ? 'Renommé : ' + val : 'Erreur renommage', !ok);
          if (ok) {
            load();
            if (XeSettings.Audio && XeSettings.Audio.refreshSinks) XeSettings.Audio.refreshSinks();
          }
        });
      });
    }
  }

  function actionKey(key) {
    if (key === 'Triangle') key = 'Enter';
    if (key === 'ArrowUp') {
      btActionFocusIdx = Math.max(0, btActionFocusIdx - 1);
      renderActionOverlay();
    } else if (key === 'ArrowDown') {
      btActionFocusIdx = Math.min(btActionItems.length - 1, btActionFocusIdx + 1);
      renderActionOverlay();
    } else if (key === 'Enter') {
      const item = btActionItems[btActionFocusIdx];
      if (item) executeAction(item.action);
    } else if (_isBack(key)) {
      closeActionOverlay();
    }
  }

  /**
   * Nom personnalisé d'un périphérique d'après son nom d'origine (celui que
   * le système, ex. evdev, utilise). Renvoie null s'il n'a pas été renommé.
   * Le 1er appel charge la liste des appareils appairés en arrière-plan puis
   * ré-affiche l'onglet courant.
   */
  let _aliasRequested = false;
  function aliasFor(name) {
    if (!_aliasRequested && window.xeLauncher?.btListPaired) {
      _aliasRequested = true;
      window.xeLauncher.btListPaired().then(devs => {
        btPaired = devs || [];
        if (typeof activeTab === 'undefined') return;
        if (activeTab === 'controllers') XeSettings.Controllers.renderDeviceMaps();
        else if (activeTab === 'jellyfin') XeSettings.Jellyfin.renderDeviceList();
      }).catch(() => {});
    }
    const n = String(name || '').toLowerCase();
    const d = btPaired.find(x => x.origName && x.origName.toLowerCase() === n && x.name !== x.origName);
    return d ? d.name : null;
  }

  /* ── API publique ── */
  return {
    get btPaired()      { return btPaired; },
    get btScanResults() { return found; },

    load, togglePower, aliasFor,
    loadHiddenDevices, saveHiddenDevices, toggleHiddenList, hideDevice, unhideDevice,
    renderBtPaired, renderHiddenBtList,
    doScan, scanKey, closeScanOverlay,
    openActionOverlay, closeActionOverlay, renderActionOverlay, actionKey,
  };
})();
