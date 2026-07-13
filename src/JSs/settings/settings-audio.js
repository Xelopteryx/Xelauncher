/**
 * settings-audio.js
 * Onglet Audio : sortie audio dynamique (PulseAudio/PipeWire sinks), volume.
 *
 * Les sinks disponibles sont récupérés via IPC get-audio-sinks (pactl list sinks).
 * Seuls les sinks dont le state != SUSPENDED sont affichés (ou tous si tous
 * sont suspendus, pour éviter une liste vide).
 */

'use strict';

window.XeSettings = window.XeSettings || {};

XeSettings.Audio = (() => {

  /* ── État ── */
  let _sinks        = [];           // [{ name, label, state }]
  let _selSinkIdx   = 0;            // index dans _sinks
  let audioVol      = 80;

  const AUDIO_VOLS  = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  let volSelIdx     = 7;            // 80 %

  let audioOutExpanded = false;
  let volExpanded      = false;

  /* ── Chargement des sinks ── */
  function refreshSinks() {
    if (!window.xeLauncher?.getAudioSinks) {
      _sinks = [{ name: 'default', label: 'Sortie par défaut', state: 'RUNNING' }];
      _renderSinkList();
      return;
    }
    window.xeLauncher.getAudioSinks().then(sinks => {
      if (!sinks || !sinks.length) {
        _sinks = [{ name: 'default', label: 'Sortie par défaut', state: 'RUNNING' }];
      } else {
        /* Afficher tous les sinks (actifs en tête) */
        _sinks = [...sinks].sort((a, b) => {
          const order = { RUNNING: 0, IDLE: 1, SUSPENDED: 2, UNKNOWN: 3 };
          return (order[a.state] ?? 3) - (order[b.state] ?? 3);
        });
      }
      _renderSinkList();
      _updateSinkLabel();
      _updateJfAudioLabel();
    });
  }

  /* ── Rendu liste des sinks ── */
  function _renderSinkList() {
    const c = document.getElementById('audioOutOptionList');
    if (!c) return;
    c.innerHTML = '';
    _sinks.forEach((s, i) => {
      const btn = document.createElement('div');
      const isSel = i === _selSinkIdx;
      const isActive = s.state === 'RUNNING' || s.state === 'IDLE';
      btn.className = 'audio-sink-item option-item'
        + (isSel    ? ' selected' : '')
        + (!isActive ? ' sink-suspended' : '');
      btn.innerHTML =
        `<span class="sink-dot ${isActive ? 'sink-dot-on' : 'sink-dot-off'}"></span>` +
        `<span class="sink-label">${s.label}</span>` +
        `<span class="sink-state">${_stateLabel(s.state)}</span>`;
      btn.addEventListener('click', () => {
        _selSinkIdx = i;
        _renderSinkList();
        _updateSinkLabel();
        _updateJfAudioLabel();
        XeSettings.Display.saveSettingsAuto();
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

  function _updateJfAudioLabel() {
    const el = document.getElementById('jfAudioSinkVal');
    if (el) el.textContent = _sinks[_selSinkIdx]?.label ?? '—';
  }

  /* ── Rendu volume ── */
  function renderVolumeOptions() {
    const c = document.getElementById('volumeOptionList');
    if (!c) return;
    c.innerHTML = '';
    AUDIO_VOLS.forEach((v, i) => {
      const btn = document.createElement('button');
      btn.className = 'option-item' + (i === volSelIdx ? ' selected' : '');
      btn.textContent = v + '%';
      btn.addEventListener('click', () => {
        volSelIdx = i; audioVol = v;
        const el = document.getElementById('volumeVal');
        if (el) el.textContent = v + '%';
        renderVolumeOptions();
        XeSettings.Display.saveSettingsAuto();
      });
      c.appendChild(btn);
    });
  }

  /* ── Toggles dropdown ── */
  function toggleOutDropdown() {
    if (audioOutExpanded) {
      audioOutExpanded = false;
      document.getElementById('audio-out-options').style.display = 'none';
      activeDropdown = null;
    } else {
      /* Actualiser la liste avant d'ouvrir */
      refreshSinks();
      audioOutExpanded = true;
      document.getElementById('audio-out-options').style.display = 'block';
      const labels = _sinks.map(s => s.label);
      openDropdown(labels, _selSinkIdx,
        (i) => {
          _selSinkIdx = i;
          _renderSinkList();
          _updateSinkLabel();
          _updateJfAudioLabel();
          XeSettings.Display.saveSettingsAuto();
          closeDropdown();
        },
        () => {
          audioOutExpanded = false;
          document.getElementById('audio-out-options').style.display = 'none';
        }
      );
    }
  }

  function toggleVolDropdown() {
    if (volExpanded) {
      volExpanded = false;
      document.getElementById('volume-options').style.display = 'none';
      activeDropdown = null;
    } else {
      volExpanded = true;
      document.getElementById('volume-options').style.display = 'block';
      renderVolumeOptions();
      openDropdown(AUDIO_VOLS.map(v => v + '%'), volSelIdx,
        (i) => {
          volSelIdx = i; audioVol = AUDIO_VOLS[i];
          const el = document.getElementById('volumeVal');
          if (el) el.textContent = AUDIO_VOLS[i] + '%';
          renderVolumeOptions();
          XeSettings.Display.saveSettingsAuto();
          closeDropdown();
        },
        () => {
          volExpanded = false;
          document.getElementById('volume-options').style.display = 'none';
        }
      );
    }
  }

  /* ── Appliquer ── */
  function applyAudio() {
    if (!window.xeLauncher) return;
    const sink = _sinks[_selSinkIdx];
    window.xeLauncher.setAudio({
      sinkName: sink?.name ?? null,
      volume:   audioVol,
    }).then(ok => {
      if (toast) toast.show(ok ? 'Audio appliqué' : 'Erreur audio', !ok);
    });
  }

  /* ── Persistance ── */
  function loadFromConfig(cfg) {
    if (!cfg) return;
    if (typeof cfg.volume === 'number') {
      const i = AUDIO_VOLS.indexOf(cfg.volume);
      volSelIdx = i >= 0 ? i : 7;
      audioVol  = AUDIO_VOLS[volSelIdx];
      const el = document.getElementById('volumeVal');
      if (el) el.textContent = audioVol + '%';
    }
    if (cfg.sinkName) {
      /* On ne peut retrouver l'index qu'après chargement des sinks */
      refreshSinks();
    }
  }

  function getConfig() {
    return {
      sinkName: _sinks[_selSinkIdx]?.name ?? null,
      sinkLabel: _sinks[_selSinkIdx]?.label ?? null,
      volume: audioVol,
    };
  }

  return {
    refreshSinks,
    renderVolumeOptions,
    toggleOutDropdown,
    toggleVolDropdown,
    applyAudio,
    loadFromConfig,
    getConfig,
    /* Rétrocompatibilité */
    renderAudioOutOptions: _renderSinkList,
  };
})();
