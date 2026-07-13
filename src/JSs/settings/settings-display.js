/**
 * settings-display.js
 * Onglet Affichage : résolution (3 colonnes), rotation inline.
 *
 * Comportement résolution :
 *   - Appuyer Entrée sur "Résolution" ouvre le panneau 3 colonnes
 *   - Gauche/Droite navigue entre les colonnes (4:3 / 16:9 / Autres)
 *   - Haut/Bas navigue dans la colonne active
 *   - Sélectionner une résolution l'applique immédiatement + timer 15s
 *   - Deux boutons "Confirmer" / "Annuler" apparaissent au centre (focus Annuler par défaut)
 *   - Retour ou Annuler = revenir à la résolution précédente
 *   - Confirmer = valider définitivement
 *
 * Comportement rotation :
 *   - Focus sur la ligne Rotation + Gauche/Droite = changer le sens
 *   - Entrée = appliquer (avec confirmation comme résolution)
 *   - Retour = annuler
 *
 * Les résolutions sont appliquées avec xrandr --scale pour conserver
 * les proportions (bandes noires si ratio différent de l'écran physique).
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.Display = (() => {

  /* ══════════════════════════════════════════════════════════════
     ÉTAT
  ══════════════════════════════════════════════════════════════ */
  let dispRes = '1920×1080';
  let dispRot = 0;            // 0 | 1 | 2 | 3  (sens horaire × 90°)

  /* Résolution active avant toute modification — pour revenir en arrière */
  let _prevRes = '1920×1080';
  let _prevRot = 0;

  /* Résolutions disponibles depuis xrandr */
  let RES_OPTS = [];

  /* Panneau résolution ouvert ? */
  let resOpen = false;

  /* 3 colonnes : 4:3 / 16:9 / Autres */
  let _cols = [[], [], []];
  let _colIdx  = 1;   // colonne focalisée
  let _rowIdxs = [0, 0, 0]; // ligne focalisée par colonne

  /* Timer revert */
  let _revertTimer   = null;
  let _revertSeconds = 15;

  /* Rotation : est-on en mode édition inline ? */
  let rotEditing  = false;

  /* Confirmation résolution/rotation : focus (0=Confirmer, 1=Annuler) */
  /* 'res' | 'rot' | null */
  let confirmMode  = null;
  let confirmFocus = 1;  // défaut sur Annuler

  /* ══════════════════════════════════════════════════════════════
     CLASSIFICATION DES RÉSOLUTIONS
  ══════════════════════════════════════════════════════════════ */
  function _classifyRes(r) {
    const s = r.replace(/[×x×]/g, 'x');
    const m = s.match(/^(\d+)x(\d+)$/);
    if (!m) return 2;
    const w = parseInt(m[1]), h = parseInt(m[2]);
    const ratio = w / h;
    if (Math.abs(ratio - 4/3)  < 0.05) return 0;
    if (Math.abs(ratio - 16/9) < 0.05) return 1;
    if (Math.abs(ratio - 16/10) < 0.05) return 1; // 16:10 → colonne 16:9
    return 2;
  }

  function _buildCols() {
    _cols = [[], [], []];
    RES_OPTS.forEach(r => _cols[_classifyRes(r)].push(r));
    // Mettre des listes par défaut si vides
    if (!_cols[0].length) _cols[0] = ['640×480','800×600','1024×768','1280×960'];
    if (!_cols[1].length) _cols[1] = ['1280×720','1920×1080','2560×1440','3840×2160'];
    if (!_cols[2].length) _cols[2] = ['1280×800','1920×1200','2560×1080','3440×1440'];
  }

  /* ══════════════════════════════════════════════════════════════
     LABELS ROTATION
  ══════════════════════════════════════════════════════════════ */
  const ROT_LABELS = [
    { label: 'Paysage',         icon: '▭ A' },
    { label: 'Portrait ↷',      icon: '▯ ⟳A' },
    { label: 'Paysage retourné',icon: '▭ ∀' },
    { label: 'Portrait ↶',      icon: '▯ ⟲A' },
  ];
  const ROT_XRANDR = ['normal', 'right', 'inverted', 'left'];

  /* ══════════════════════════════════════════════════════════════
     CHARGEMENT
  ══════════════════════════════════════════════════════════════ */
  function loadDisplayModes() {
    if (!window.xeLauncher) { _buildCols(); return; }
    window.xeLauncher.getDisplayModes().then(modes => {
      if (modes && modes.resolutions && modes.resolutions.length) {
        RES_OPTS = modes.resolutions;
      } else {
        RES_OPTS = ['640×480','800×600','1024×768',
                    '1280×720','1920×1080','2560×1440','3840×2160',
                    '1280×800','2560×1080'];
      }
      _buildCols();
      // Retrouver la colonne de la résolution active
      const cat = _classifyRes(dispRes);
      _colIdx = cat;
      const idx = _cols[cat].indexOf(dispRes);
      _rowIdxs[cat] = idx >= 0 ? idx : 0;
      _updateResLabel();
    });
  }

  /**
   * Interroge le système (xrandr) pour connaître la résolution et la
   * rotation RÉELLEMENT actives, et les impose comme valeurs de référence.
   * À appeler en DERNIER dans l'init (après loadSavedSettings), pour que
   * la réalité écrase toujours ce qui était simplement sauvegardé.
   */
  function loadCurrentDisplay() {
    if (!window.xeLauncher?.getCurrentDisplay) return;
    window.xeLauncher.getCurrentDisplay().then(state => {
      if (!state) return;
      if (state.resolution) {
        dispRes  = state.resolution.replace('x', '×');
        _prevRes = dispRes;
      }
      if (state.rotation) {
        const idx = ROT_XRANDR.indexOf(state.rotation);
        if (idx >= 0) { dispRot = idx; _prevRot = idx; }
      }
      _updateResLabel();
      _updateRotLabel();
      // Si le panneau résolution a déjà construit ses colonnes, repositionner le focus
      if (RES_OPTS.length) {
        const cat = _classifyRes(dispRes);
        _colIdx = cat;
        const idx2 = _cols[cat].indexOf(dispRes);
        _rowIdxs[cat] = idx2 >= 0 ? idx2 : 0;
      }
    }).catch(() => {});
  }

  function loadSavedSettings() {
    const saved = localStorage.getItem('xelauncher_settings');
    if (!saved) return;
    try {
      const cfg = JSON.parse(saved);
      if (cfg.display) {
        if (cfg.display.resolution) {
          dispRes  = cfg.display.resolution;
          _prevRes = cfg.display.resolution;
          _updateResLabel();
        }
        if (typeof cfg.display.rotIdx === 'number') {
          dispRot  = cfg.display.rotIdx & 3;
          _prevRot = dispRot;
          _updateRotLabel();
        }
      }
    } catch(e) {}
  }

  function saveSettingsAuto() {
    const cfg = {
      display: { resolution: dispRes, rotIdx: dispRot },
      audio:   XeSettings.Audio.getConfig(),
    };
    localStorage.setItem('xelauncher_settings', JSON.stringify(cfg));
  }

  function getConfig() {
    return { resolution: dispRes, rotIdx: dispRot };
  }

  /* ══════════════════════════════════════════════════════════════
     MISES À JOUR LABELS
  ══════════════════════════════════════════════════════════════ */
  function _updateResLabel() {
    const el = document.getElementById('resValue');
    if (el) el.textContent = dispRes;
  }

  function _updateRotLabel() {
    const el = document.getElementById('rotValue');
    if (el) {
      const r = ROT_LABELS[dispRot];
      el.textContent = r ? r.label : 'Paysage';
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PANNEAU RÉSOLUTION — RENDU
  ══════════════════════════════════════════════════════════════ */
  const COL_TITLES = ['4 : 3', '16 : 9', 'Autres'];

  function renderResPanel() {
    const panel = document.getElementById('resColumnsPanel');
    if (!panel) return;
    panel.innerHTML = '';

    _cols.forEach((col, ci) => {
      const colEl = document.createElement('div');
      colEl.className = 'res-col' + (ci === _colIdx ? ' res-col-active' : '');

      const title = document.createElement('div');
      title.className = 'res-col-title';
      title.textContent = COL_TITLES[ci];
      colEl.appendChild(title);

      col.forEach((r, ri) => {
        const btn = document.createElement('div');
        const isColFocused = ci === _colIdx;
        const isRowFocused = ri === _rowIdxs[ci];
        const isCurrent    = r === dispRes;
        btn.className = 'res-item'
          + (isCurrent   ? ' res-item-current'  : '')
          + (isColFocused && isRowFocused ? ' res-item-focused' : '');
        btn.textContent = r;
        btn.addEventListener('click', () => {
          _colIdx = ci;
          _rowIdxs[ci] = ri;
          _selectRes(r);
        });
        colEl.appendChild(btn);
      });

      panel.appendChild(colEl);
    });

    // Afficher/masquer la zone de confirmation
    const zone = document.getElementById('resConfirmZone');
    if (zone) zone.style.display = confirmMode === 'res' ? 'flex' : 'none';
    if (confirmMode === 'res') {
      _updateConfirmButtons();
      _updateRevertCountdown();
    }
  }

  function _updateConfirmButtons() {
    const ok  = document.getElementById('resConfirmBtn');
    const can = document.getElementById('resCancelBtn');
    if (!ok || !can) return;
    ok.classList.toggle('active',  confirmFocus === 0);
    can.classList.toggle('active', confirmFocus === 1);
  }

  function _updateRevertCountdown() {
    const el = document.getElementById('resRevertCountdown');
    if (el) el.textContent = _revertSeconds;
  }

  /* ══════════════════════════════════════════════════════════════
     SÉLECTION + APPLICATION D'UNE RÉSOLUTION
  ══════════════════════════════════════════════════════════════ */
  function _selectRes(r) {
    _clearRevertTimer();
    const prev = dispRes;
    dispRes = r;
    _updateResLabel();
    renderResPanel();

    // Appliquer immédiatement
    if (window.xeLauncher) {
      window.xeLauncher.setDisplay({
        resolution: r.replace('×', 'x'),
        rotation:   ROT_XRANDR[dispRot],
        keepAspect: true,
      });
    }

    // Passer en mode confirmation
    confirmMode  = 'res';
    confirmFocus = 1; // Annuler par défaut
    _revertSeconds = 15;

    // Timer revert
    _revertTimer = setInterval(() => {
      _revertSeconds--;
      _updateRevertCountdown();
      if (_revertSeconds <= 0) {
        _cancelRes(prev);
      }
    }, 1000);

    renderResPanel();
  }

  function _clearRevertTimer() {
    if (_revertTimer) { clearInterval(_revertTimer); _revertTimer = null; }
  }

  function confirmRes() {
    _clearRevertTimer();
    _prevRes    = dispRes;
    confirmMode = null;
    saveSettingsAuto();
    renderResPanel();
    toast.show('Résolution confirmée : ' + dispRes, false);
  }

  function _cancelRes(revertTo) {
    _clearRevertTimer();
    const target = revertTo || _prevRes;
    dispRes = target;
    _updateResLabel();
    if (window.xeLauncher) {
      window.xeLauncher.setDisplay({
        resolution: target.replace('×', 'x'),
        rotation:   ROT_XRANDR[dispRot],
        keepAspect: true,
      });
    }
    confirmMode = null;
    renderResPanel();
    toast.show('Résolution annulée', false);
  }

  /* ══════════════════════════════════════════════════════════════
     ROTATION — RENDU INLINE
  ══════════════════════════════════════════════════════════════ */
  function renderRotRow() {
    const el = document.getElementById('rotValue');
    if (!el) return;
    if (!rotEditing) {
      const r = ROT_LABELS[dispRot];
      el.textContent = r ? r.label : 'Paysage';
      return;
    }
    // Mode édition : afficher les 4 options horizontalement
    el.innerHTML = '';
    ROT_LABELS.forEach((r, i) => {
      const span = document.createElement('span');
      span.className = 'rot-option' + (i === dispRot ? ' rot-option-active' : '');
      span.innerHTML = `<span class="rot-icon">${r.icon}</span> ${r.label}`;
      el.appendChild(span);
    });
  }

  /* ══════════════════════════════════════════════════════════════
     API PUBLIQUE — appelée par settings-core
  ══════════════════════════════════════════════════════════════ */

  /**
   * Ouvre / ferme le panneau résolution.
   * Appelé quand l'utilisateur appuie Entrée sur la ligne résolution.
   */
  function toggleResPanel() {
    if (resOpen) {
      // Fermeture : si confirmation en cours → annuler
      if (confirmMode === 'res') _cancelRes();
      resOpen = false;
      document.getElementById('res-options').style.display = 'none';
      confirmMode = null;
    } else {
      resOpen = true;
      document.getElementById('res-options').style.display = 'block';
      // Positionner le focus sur la colonne de la résolution active
      const cat = _classifyRes(dispRes);
      _colIdx = cat;
      const idx = _cols[cat].indexOf(dispRes);
      _rowIdxs[cat] = idx >= 0 ? idx : 0;
      confirmMode = null;
      renderResPanel();
    }
  }

  /**
   * Navigation clavier dans le panneau résolution.
   * Retourne true si la touche a été consommée.
   */
  function handleResKey(key) {
    if (!resOpen) return false;

    // Mode confirmation
    if (confirmMode === 'res') {
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        confirmFocus = confirmFocus === 0 ? 1 : 0;
        _updateConfirmButtons();
        return true;
      }
      if (key === 'Enter') {
        if (confirmFocus === 0) confirmRes(); else _cancelRes();
        return true;
      }
      if (key === 'Escape' || key === 'Back' || key === 'Backspace') {
        _cancelRes();
        return true;
      }
      return true; // bloquer toute autre navigation pendant la confirmation
    }

    // Navigation normale dans les colonnes
    if (key === 'ArrowLeft') {
      _colIdx = Math.max(0, _colIdx - 1);
      renderResPanel();
      return true;
    }
    if (key === 'ArrowRight') {
      _colIdx = Math.min(2, _colIdx + 1);
      renderResPanel();
      return true;
    }
    if (key === 'ArrowUp') {
      _rowIdxs[_colIdx] = Math.max(0, _rowIdxs[_colIdx] - 1);
      renderResPanel();
      return true;
    }
    if (key === 'ArrowDown') {
      _rowIdxs[_colIdx] = Math.min(_cols[_colIdx].length - 1, _rowIdxs[_colIdx] + 1);
      renderResPanel();
      return true;
    }
    if (key === 'Enter') {
      const r = _cols[_colIdx][_rowIdxs[_colIdx]];
      if (r) _selectRes(r);
      return true;
    }
    if (key === 'Escape' || key === 'Back' || key === 'Backspace') {
      // Fermer sans changer
      resOpen = false;
      document.getElementById('res-options').style.display = 'none';
      return true;
    }
    return true;
  }

  /**
   * Navigation clavier sur la ligne rotation (uniquement quand cette ligne est focalisée).
   * Retourne true si consommé.
   */
  function handleRotKey(key) {
    if (!rotEditing) {
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        // Entrer en mode édition + changer
        rotEditing = true;
        if (key === 'ArrowLeft')  dispRot = (dispRot + 3) & 3;
        else                       dispRot = (dispRot + 1) & 3;
        renderRotRow();
        return true;
      }
      if (key === 'Enter') {
        rotEditing = true;
        renderRotRow();
        return true;
      }
      return false;
    }

    // En mode édition inline
    if (key === 'ArrowLeft') {
      dispRot = (dispRot + 3) & 3;
      renderRotRow();
      return true;
    }
    if (key === 'ArrowRight') {
      dispRot = (dispRot + 1) & 3;
      renderRotRow();
      return true;
    }
    if (key === 'Enter') {
      // Appliquer la rotation
      _applyRotation();
      return true;
    }
    if (key === 'Escape' || key === 'Back' || key === 'Backspace') {
      // Annuler : remettre la rotation précédente
      dispRot    = _prevRot;
      rotEditing = false;
      renderRotRow();
      return true;
    }
    return true;
  }

  function _applyRotation() {
    if (!window.xeLauncher) return;
    window.xeLauncher.setDisplay({
      resolution: dispRes.replace('×', 'x'),
      rotation:   ROT_XRANDR[dispRot],
      keepAspect: true,
    }).then(ok => {
      if (ok) {
        _prevRot   = dispRot;
        rotEditing = false;
        saveSettingsAuto();
        renderRotRow();
        toast.show('Rotation appliquée', false);
      } else {
        dispRot    = _prevRot;
        rotEditing = false;
        renderRotRow();
        toast.show('Erreur rotation', true);
      }
    });
  }

  /**
   * Vrai si le panneau résolution est ouvert (pour bloquer la nav globale).
   */
  function isResOpen() { return resOpen; }

  /**
   * Vrai si la ligne rotation est en mode édition (pour bloquer la nav globale).
   */
  function isRotEditing() { return rotEditing; }

  /* Init des boutons Confirmer / Annuler dans le HTML */
  function _initButtons() {
    const ok  = document.getElementById('resConfirmBtn');
    const can = document.getElementById('resCancelBtn');
    if (ok)  ok.addEventListener('click',  () => confirmRes());
    if (can) can.addEventListener('click', () => _cancelRes());
  }

  /* Appeler après DOMContentLoaded pour brancher les boutons */
  function init() {
    _initButtons();
    _updateResLabel();
    _updateRotLabel();
  }

  return {
    loadDisplayModes, loadSavedSettings, loadCurrentDisplay, saveSettingsAuto, getConfig,
    init,
    toggleResPanel,
    handleResKey,
    handleRotKey,
    isResOpen,
    isRotEditing,
    renderResPanel,
    renderRotRow,
    /* Rétrocompatibilité avec l'ancien code core qui appelle applyDisplay */
    applyDisplay: () => {},
  };
})();
