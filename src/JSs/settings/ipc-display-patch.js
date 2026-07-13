/* ── Audio Sinks (PipeWire/PulseAudio) ── */
// Ajout à ipc-display.js : lister les sorties audio disponibles

ipcMain.handle('get-audio-sinks', async () => new Promise(resolve => {
  exec('pactl list sinks short 2>/dev/null', (err, out) => {
    if (err || !out.trim()) {
      // Fallback ALSA
      exec('aplay -l 2>/dev/null', (e2, o2) => {
        const sinks = [];
        if (!e2 && o2) {
          const lines = o2.split('\n');
          lines.forEach(line => {
            const m = line.match(/^card \d+: (.+?) \[(.+?)\].*device \d+: (.+?) \[(.+?)\]/);
            if (m) {
              const cardName = m[2] || m[1];
              const devName  = m[4] || m[3];
              let type = 'analog';
              if (/hdmi/i.test(devName) || /hdmi/i.test(cardName)) type = 'hdmi';
              sinks.push({ name: 'alsa:' + cardName + ':' + devName, description: cardName + ' — ' + devName, type });
            }
          });
        }
        if (!sinks.length) {
          sinks.push({ name: 'hdmi',   description: 'HDMI',       type: 'hdmi'   });
          sinks.push({ name: 'analog', description: 'Analogique', type: 'analog' });
        }
        resolve(sinks);
      });
      return;
    }

    // Collecter les noms courts
    const shortSinks = [];
    out.trim().split('\n').forEach(line => {
      const parts = line.split('\t');
      if (parts.length >= 2) shortSinks.push({ idx: parts[0], name: parts[1] });
    });

    if (!shortSinks.length) { resolve([]); return; }

    // Récupérer les descriptions complètes
    exec('pactl list sinks 2>/dev/null', (e3, detailOut) => {
      const sinks = [];
      if (!e3 && detailOut) {
        const blocks = detailOut.split(/\nSink #/);
        blocks.forEach(block => {
          const nameMatch = block.match(/Name:\s+(.+)/);
          const descMatch = block.match(/Description:\s+(.+)/);
          if (!nameMatch) return;
          const name = nameMatch[1].trim();
          const desc = descMatch ? descMatch[1].trim() : name;
          let type = 'analog';
          if (/hdmi/i.test(name) || /hdmi/i.test(desc))              type = 'hdmi';
          else if (/blue|a2dp|avdtp/i.test(name) || /blue/i.test(desc)) type = 'bt';
          else if (/usb/i.test(name) || /usb/i.test(desc))          type = 'usb';
          sinks.push({ name, description: desc, type });
        });
      }
      // Compléter avec les sinks courts si la description a raté
      shortSinks.forEach(ss => {
        if (!sinks.find(s => s.name === ss.name)) {
          let type = 'analog';
          if (/hdmi/i.test(ss.name)) type = 'hdmi';
          else if (/blue/i.test(ss.name)) type = 'bt';
          sinks.push({ name: ss.name, description: ss.name, type });
        }
      });
      resolve(sinks);
    });
  });
}))

/* ── setAudio amélioré : supporte sinkName pour PipeWire ── */
// Remplace le handler existant set-audio dans ipc-display.js
// (À ajouter après, le dernier handler ipcMain.handle('set-audio',...) sera surchargé)
ipcMain.handle('set-audio-v2', async (_, opts) => {
  const { loadConfig, saveConfig } = require('./helpers')
  const cfg = loadConfig()
  cfg.audio = opts
  saveConfig(cfg)
  return new Promise(resolve => {
    const vol = Math.min(100, Math.max(0, opts.volume || 80))
    const sinkName = opts.sinkName || null

    exec('which pactl', (err, pactlPath) => {
      if (!err && pactlPath.trim()) {
        const cmds = [`pactl set-sink-volume @DEFAULT_SINK@ ${vol}%`]
        if (sinkName) {
          cmds.unshift(`pactl set-default-sink "${sinkName}"`)
        }
        exec(cmds.join(' && '), e => {
          // Mettre à jour aussi la variable d'environnement PULSE_SINK pour JMP
          if (sinkName) {
            exec(`pactl set-default-sink "${sinkName}"`, () => {})
          }
          resolve(!e)
        })
      } else {
        exec(`amixer sset Master ${vol}%`, e => resolve(!e))
      }
    })
  })
})
