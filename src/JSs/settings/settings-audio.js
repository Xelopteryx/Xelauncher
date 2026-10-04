/**
 * settings-audio.js
 * Onglet Audio : sortie audio globale (PulseAudio/PipeWire sinks), volume.
 *
 * Sortie audio : liste verticale, navigation Haut/Bas (pas Gauche/Droite —
 * ça n'avait aucun sens pour une colonne), focus visuellement indiqué,
 * Entrée sélectionne + applique + ferme. Chargée automatiquement à
 * l'arrivée sur la page (avant il fallait ouvrir le menu ou cliquer sur
 * "Actualiser" pour que quoi que ce soit apparaisse).
 *
 * Volume : simple curseur 0-100, plus de boutons par paliers de 10%.
 *
 * La sortie choisie est globale à la machine (pactl set-default-sink),
 * pas spécifique à Jellyfin — la section "Sortie Jellyfin" qui dupliquait
 * l'info a été retirée du HTML.
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.Audio = (() => {

  /* ── État ── */
  let _sinks       = [];   // [{ name, label, state }]
  let _selSinkIdx  = 0;    // sink actuellement appliqué
  let audioVol     = 80;

  /* Nom du sink à restaurer une fois la liste chargée (config sauvegardée,
     lue avant que la liste asynchrone des sinks ne soit disponible). */
  let _pendingSinkName = null;

  /* ── Panneau "Sortie audio" : état de navigation dédié (Haut/Bas) ── */
  let audioOutOpen  = false;
  let _outFocusIdx  = 0;    // index survolé pendant la navigation, avant validation

  let _volApplyTimer = null;

  /* Nom personnalisé donné dans Bluetooth → utilisé aussi comme libellé de
     la sortie audio correspondante (bluez_output.AA_BB_CC_DD_EE_FF.1). */
  function _withBtNames(list) {
    if (!window.xeLauncher?.btNames || !list.some(s => /bluez_/i.test(s.name || ''))) return Promise.resolve(list);
    return window.xeLauncher.btNames().then(names => {
      names = names || {};
      return list.map(s => {
        const m   = (s.name || '').match(/bluez_[a-z]+\.([0-9A-F]{2}(?:_[0-9A-F]{2}){5})/i);
        const mac = m ? m[1].replace(/_/g, ':').toUpperCase() : null;
        return mac && names[mac] ? { ...s, label: names[mac] } : s;
      });
    }).catch(() => list);
  }

  /* ── Chargement des sinks ── */
  function refreshSinks(cb) {
    if (!window.xeLauncher?.getAudioSinks) {
      _sinks = [{ name: 'default', label: 'Sortie par défaut', state: 'RUNNING' }];
      _afterSinksLoaded();
      if (cb) cb();
      return;
    }
    window.xeLauncher.getAudioSinks().then(sinks => _withBtNames(sinks || [])).then(sinks => {
      if (!sinks || !sinks.length) {
        _sinks = [{ name: 'default', label: 'Sortie par défaut', state: 'RUNNING' }];
      } else {
        /* Afficher tous les sinks (actifs en tête) */
        _sinks = [...sinks].sort((a, b) => {
          const order = { RUNNING: 0, IDLE: 1, SUSPENDED: 2, UNKNOWN: 3 };
          return (order[a.state] ?? 3) - (order[b.state] ?? 3);
        });
      }
      _afterSinksLoaded();
      if (cb) cb();
    }).catch(() => { if (cb) cb(); });
  }

  /**
   * Actualisation déclenchée explicitement par l'utilisateur (bouton
   * "Actualiser les sorties audio") : contrairement aux rafraîchissements
   * silencieux (démarrage, ouverture du menu déroulant), celle-ci doit se
   * voir — libellé du bouton qui change pendant le chargement, puis un
   * toast donnant le nombre de sorties trouvées, pour qu'on sache que
   * quelque chose s'est réellement passé.
   */
  function manualRefresh() {
    const row = document.querySelector('[data-action="refresh-sinks"] .settings-row-label');
    const original = row ? row.textContent : null;
    if (row) row.textContent = '↻ Actualisation…';
    refreshSinks(() => {
      if (row) row.textContent = original || '↻ Actualiser les sorties audio';
      if (toast) {
        const n = _sinks.length;
        toast.show(n + ' sortie' + (n > 1 ? 's' : '') + ' audio détectée' + (n > 1 ? 's' : ''), false);
      }
    });
  }

  function _afterSinksLoaded() {
    /* Restaurer le choix sauvegardé si on le retrouve dans la liste
       fraîche — sinon on garde le 1er sink (le plus "actif" grâce au tri). */
    if (_pendingSinkName) {
      const idx = _sinks.findIndex(s => s.name === _pendingSinkName);
      if (idx >= 0) _selSinkIdx = idx;
      _pendingSinkName = null;
    } else if (_selSinkIdx >= _sinks.length) {
      _selSinkIdx = 0;
    }
    _renderSinkList();
    _updateSinkLabel();
  }

  /* ── Rendu liste des sinks ──
     .selected = sink actuellement appliqué. .focused = sink survolé
     pendant la navigation Haut/Bas (visible uniquement panneau ouvert). */
  function _renderSinkList() {
    const c = document.getElementById('audioOutOptionList');
    if (!c) return;
    c.innerHTML = '';
    if (!_sinks.length) {
      c.innerHTML = '<div style="color:var(--text-dim);font-family:var(--font-admin);font-size:var(--fs-hint);letter-spacing:2px;text-transform:uppercase;padding:10px 16px">Aucune sortie détectée</div>';
      return;
    }
    _sinks.forEach((s, i) => {
      const btn = document.createElement('div');
      const isSel     = i === _selSinkIdx;
      const isFocused = audioOutOpen && i === _outFocusIdx;
      const isActive  = s.state === 'RUNNING' || s.state === 'IDLE';
      btn.className = 'audio-sink-item option-item'
        + (isSel     ? ' selected' : '')
        + (isFocused ? ' focused'  : '')
        + (!isActive ? ' sink-suspended' : '');
      btn.innerHTML =
        `<span class="sink-dot ${isActive ? 'sink-dot-on' : 'sink-dot-off'}"></span>` +
        `<span class="sink-label">${s.label}</span>` +
        `<span class="sink-state">${_stateLabel(s.state)}</span>`;
      btn.addEventListener('click', () => {
        _selSinkIdx = i;
        _outFocusIdx = i;
        _renderSinkList();
        _updateSinkLabel();
        XeSettings.Display.saveSettingsAuto();
        applyAudio(true);
        closeAudioOut(false);
      });
      c.appendChild(btn);
    });
  }

  function _stateLabel(state) {
    return { RUNNING: '●', IDLE: '◌', SUSPENDED: '—', UNKNOWN: '?' }[state] ?? '?';
  }

  function _updateSinkLabel() {
    const el = document.getElementById('audioOutVal');
    if (el) el.textContent = _sinks[_selSinkIdx]?.label ?? '—';
  }

  /* ── Panneau "Sortie audio" — ouverture / fermeture / navigation ── */
  function toggleOutDropdown() {
    if (audioOutOpen) closeAudioOut(true);
    else               openAudioOut();
  }

  function openAudioOut() {
    refreshSinks(); /* actualiser la liste à chaque ouverture */
    audioOutOpen = true;
    _outFocusIdx = _selSinkIdx;
    const panel = document.getElementById('audio-out-options');
    if (panel) panel.style.display = 'block';
    _renderSinkList();
  }

  /**
   * Ferme le panneau. apply=true : valide le sink survolé (Entrée) ;
   * apply=false : referme sans rien changer (Échap, ou déjà géré par le
   * clic qui a appliqué lui-même avant d'appeler closeAudioOut(false)).
   */
  function closeAudioOut(apply) {
    if (apply && _outFocusIdx !== _selSinkIdx) {
      _selSinkIdx = _outFocusIdx;
      XeSettings.Display.saveSettingsAuto();
      applyAudio(true);
    }
    audioOutOpen = false;
    const panel = document.getElementById('audio-out-options');
    if (panel) panel.style.display = 'none';
    _renderSinkList();
    _updateSinkLabel();
    _focusAudioOutRow();
  }

  function isOutOpen() { return audioOutOpen; }

  /** Navigation Haut/Bas + Entrée/Échap pendant que le panneau est ouvert. */
  function handleAudioOutKey(key) {
    if (!audioOutOpen) return false;
    if (key === 'ArrowUp') {
      _outFocusIdx = Math.max(0, _outFocusIdx - 1);
      _renderSinkList();
      return true;
    }
    if (key === 'ArrowDown') {
      _outFocusIdx = Math.min(_sinks.length - 1, _outFocusIdx + 1);
      _renderSinkList();
      return true;
    }
    if (key === 'Enter') { closeAudioOut(true); return true; }
    if (key === 'Escape' || key === 'Back' || key === 'Backspace') { closeAudioOut(false); return true; }
    return true; /* bloquer le reste tant que le panneau est ouvert */
  }

  /** Focus clavier/manette de retour sur la ligne "Sortie audio" à la fermeture. */
  function _focusAudioOutRow() {
    if (typeof getContentRows !== 'function' || typeof rowFocusMap === 'undefined') return;
    const rows = getContentRows();
    const idx  = rows.findIndex(el => el.id === 'row-audio-out');
    if (idx >= 0 && typeof activeTab !== 'undefined') rowFocusMap[activeTab] = idx;
    if (typeof updateContentFocus === 'function') updateContentFocus();
  }

  /* ── Volume — curseur simple 0-100, replié par défaut ──
     Même principe que Rotation/Sortie audio : "Sélectionner" fait
     apparaître la barre et y déplace le focus visuellement (point
     mis en évidence), au lieu de rester sur la ligne "Volume" avec
     Gauche/Droite qui agissaient directement dessus sans état "ouvert"
     clair. */
  let volumeOpen = false;

  function _updateVolumeUI() {
    const slider = document.getElementById('volumeSlider');
    const label  = document.getElementById('volumeVal');
    if (slider) {
      slider.value = audioVol;
      slider.style.background =
        `linear-gradient(to right, var(--blue) ${audioVol}%, rgba(255,255,255,0.1) ${audioVol}%)`;
      slider.classList.toggle('focused', volumeOpen);
    }
    if (label) label.textContent = audioVol + '%';
  }

  function isVolumeOpen() { return volumeOpen; }

  function toggleVolumeOpen() {
    if (volumeOpen) closeVolume();
    else             openVolume();
  }

  function openVolume() {
    volumeOpen = true;
    const wrap = document.getElementById('volumeSliderWrap');
    if (wrap) wrap.style.display = 'flex';
    _updateVolumeUI();
    const slider = document.getElementById('volumeSlider');
    if (slider) slider.focus();
  }

  function closeVolume() {
    volumeOpen = false;
    const wrap = document.getElementById('volumeSliderWrap');
    if (wrap) wrap.style.display = 'none';
    _updateVolumeUI();
    _focusVolumeRow();
  }

  /** Navigation Gauche/Droite + Entrée/Échap pendant que la barre est ouverte. */
  function handleVolumeKey(key) {
    if (!volumeOpen) return false;
    if (key === 'ArrowLeft')  { stepVolume(-1); return true; }
    if (key === 'ArrowRight') { stepVolume(1);  return true; }
    if (key === 'Enter' || key === 'Escape' || key === 'Back' || key === 'Backspace') {
      closeVolume();
      return true;
    }
    return true; /* bloquer le reste tant que la barre est ouverte */
  }

  /** Focus clavier/manette de retour sur la ligne "Volume" à la fermeture. */
  function _focusVolumeRow() {
    if (typeof getContentRows !== 'function' || typeof rowFocusMap === 'undefined') return;
    const rows = getContentRows();
    const idx  = rows.findIndex(el => el.id === 'row-volume');
    if (idx >= 0 && typeof activeTab !== 'undefined') rowFocusMap[activeTab] = idx;
    if (typeof updateContentFocus === 'function') updateContentFocus();
  }

  /** Glisser le curseur (souris/tactile) : feedback instantané, application débouncée. */
  function onVolumeSliderInput(rawValue) {
    audioVol = Math.max(0, Math.min(100, parseInt(rawValue, 10) || 0));
    _updateVolumeUI();
    clearTimeout(_volApplyTimer);
    _volApplyTimer = setTimeout(() => {
      XeSettings.Display.saveSettingsAuto();
      applyAudio(false);
    }, 150);
  }

  /** Pas discret (clavier/manette gauche-droite une fois la barre ouverte). */
  function stepVolume(direction) {
    audioVol = Math.max(0, Math.min(100, audioVol + direction * 5));
    _updateVolumeUI();
    clearTimeout(_volApplyTimer);
    _volApplyTimer = setTimeout(() => {
      XeSettings.Display.saveSettingsAuto();
      applyAudio(false);
    }, 120);
  }

  /**
   * Sélectionne comme sortie audio le sink Bluetooth d'un appareil donné
   * (appelé après un appairage/une connexion réussie, ou depuis « Utiliser
   * comme sortie audio »). Le sink n'apparaît dans PipeWire/PulseAudio que
   * quelques secondes après la connexion : on réessaie jusqu'à ~8 s, et à
   * mi-chemin on demande au système de basculer la carte en profil A2DP.
   */
  function selectSinkForDevice(mac) {
    const key = String(mac || '').replace(/:/g, '_').toLowerCase();
    if (!key) return;
    let tries = 0, fixed = false;

    const attempt = () => {
      refreshSinks(() => {
        const idx = _sinks.findIndex(s => (s.name || '').toLowerCase().includes(key));
        if (idx >= 0) {
          _selSinkIdx  = idx;
          _outFocusIdx = idx;
          _renderSinkList();
          _updateSinkLabel();
          XeSettings.Display.saveSettingsAuto();
          applyAudio(false);
          if (toast) toast.show('Sortie audio : ' + _sinks[idx].label, false);
          return;
        }
        tries++;
        if (tries === 3 && !fixed && window.xeLauncher?.btAudioFix) {
          fixed = true;
          window.xeLauncher.btAudioFix(mac).catch(() => {}).then(() => setTimeout(attempt, 1000));
          return;
        }
        if (tries < 8) { setTimeout(attempt, 1000); return; }
        const fallback = 'Casque connecté, mais aucune sortie audio Bluetooth n\u2019est apparue';
        const diag = window.xeLauncher?.btDiagnose
          ? window.xeLauncher.btDiagnose(mac).then(r => (r && r.problems && r.problems[0]) || '').catch(() => '')
          : Promise.resolve('');
        diag.then(cause => { if (toast) toast.show(cause ? 'Pas de sortie audio — ' + cause : fallback, true); });
      });
    };
    attempt();
  }

  /* ── Appliquer ── */
  function applyAudio(showToast) {
    if (!window.xeLauncher) return;
    const sink = _sinks[_selSinkIdx];
    window.xeLauncher.setAudio({
      sinkName: sink?.name ?? null,
      volume:   audioVol,
    }).then(ok => {
      if (showToast && toast) toast.show(ok ? 'Audio appliqué' : 'Erreur audio', !ok);
    });
  }

  /* ── Persistance (localStorage 'xelauncher_settings', clé "audio") ── */
  function loadSavedSettings() {
    const saved = localStorage.getItem('xelauncher_settings');
    if (!saved) return;
    try {
      const cfg = JSON.parse(saved);
      if (cfg.audio) {
        if (typeof cfg.audio.volume === 'number') {
          audioVol = Math.max(0, Math.min(100, cfg.audio.volume));
          _updateVolumeUI();
        }
        if (cfg.audio.sinkName) _pendingSinkName = cfg.audio.sinkName;
      }
    } catch (e) {}
  }

  function getConfig() {
    return {
      sinkName:  _sinks[_selSinkIdx]?.name  ?? null,
      sinkLabel: _sinks[_selSinkIdx]?.label ?? null,
      volume:    audioVol,
    };
  }

  function init() {
    const slider = document.getElementById('volumeSlider');
    if (slider) {
      slider.addEventListener('input', (e) => onVolumeSliderInput(e.target.value));
      _updateVolumeUI();
    }
  }

  return {
    init,
    refreshSinks,
    manualRefresh,
    toggleOutDropdown,
    openAudioOut,
    closeAudioOut,
    isOutOpen,
    handleAudioOutKey,
    toggleVolumeOpen,
    isVolumeOpen,
    handleVolumeKey,
    stepVolume,
    applyAudio,
    selectSinkForDevice,
    loadSavedSettings,
    getConfig,
  };
})();
