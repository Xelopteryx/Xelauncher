/**
 * ipc-display.js
 * IPC : affichage (résolution, rotation) et audio.
 *
 * keepAspect=true : applique la résolution logique demandée en gardant
 * les proportions — xrandr --scale-from crée des bandes noires si le
 * ratio diffère de la résolution physique de l'écran.
 */

'use strict'

const { ipcMain } = require('electron')
const { exec }    = require('child_process')
const { loadConfig, saveConfig } = require('./helpers')

/* ── Helpers xrandr ── */
function _getOutput() {
  return new Promise(resolve => {
    exec("xrandr | grep ' connected' | awk '{print $1}' | head -1", (e, out) => {
      resolve((out || '').trim() || 'HDMI-1')
    })
  })
}

function _getNativeRes() {
  return new Promise(resolve => {
    exec("xrandr | grep -A1 ' connected' | tail -1 | awk '{print $1}'", (e, out) => {
      const m = (out || '').trim().match(/^(\d+)x(\d+)/)
      resolve(m ? { w: parseInt(m[1]), h: parseInt(m[2]) } : null)
    })
  })
}

/* ── Affichage ── */
ipcMain.handle('get-display-modes', async () => new Promise(resolve => {
  exec('which xrandr', err => {
    if (err) return resolve({ resolutions: [], refreshRates: [] })
    exec("xrandr | grep ' connected' | awk '{print $1}' | head -1", (e, out) => {
      const output = (out || '').trim() || 'HDMI-1'
      exec('xrandr --query', (e2, xout) => {
        if (e2 || !xout) return resolve({ resolutions: [], refreshRates: [] })
        const lines      = xout.split('\n')
        let inOutput     = false
        const resSeen    = new Set()
        const rateSeen   = new Set()
        const resolutions  = []
        const refreshRates = []
        for (const line of lines) {
          if (line.startsWith(output))           { inOutput = true; continue }
          else if (inOutput && /^\S/.test(line)) break
          if (!inOutput) continue
          const modeMatch = line.match(/^\s+(\d+x\d+)/)
          if (!modeMatch) continue
          const res = modeMatch[1].replace('x', '×')
          if (!resSeen.has(res)) { resSeen.add(res); resolutions.push(res) }
          const rates = [...line.matchAll(/(\d+\.\d+)/g)].map(m => Math.round(parseFloat(m[1])) + 'Hz')
          rates.forEach(r => { if (!rateSeen.has(r)) { rateSeen.add(r); refreshRates.push(r) } })
        }
        resolve({ resolutions, refreshRates })
      })
    })
  })
}))

ipcMain.handle('set-display', async (_, opts) => {
  const cfg = loadConfig()
  cfg.display = opts
  saveConfig(cfg)

  return new Promise(async resolve => {
    const res        = (opts.resolution || '1920x1080').replace(/[×x×]/g, 'x')
    const [lw, lh]   = res.split('x').map(Number)
    const rate       = parseInt(opts.refresh) || 60
    const rot        = opts.rotation || 'normal'   // déjà 'normal'|'left'|'right'|'inverted'
    const keepAspect = opts.keepAspect !== false    // true par défaut

    exec('which xrandr', async err => {
      if (err) {
        exec(`sudo raspi-config nonint do_resolution ${lw} ${lh}`, e4 => resolve(!e4))
        return
      }

      const output    = await _getOutput()
      const nativeRes = keepAspect ? await _getNativeRes() : null

      let cmd
      if (keepAspect && nativeRes && (nativeRes.w !== lw || nativeRes.h !== lh)) {
        /* Bandes noires : passer à la résolution native puis utiliser
           --scale-from pour afficher uniquement lw×lh centré */
        const scaleX = (nativeRes.w / lw).toFixed(6)
        const scaleY = (nativeRes.h / lh).toFixed(6)
        // Positionner le viewport au centre
        const offX = Math.round((nativeRes.w - lw) / 2)
        const offY = Math.round((nativeRes.h - lh) / 2)
        cmd = `xrandr --output ${output} --scale ${scaleX}x${scaleY} --rotate ${rot}`
      } else {
        /* Résolution native ou pas de keepAspect : appliquer directement */
        cmd = `xrandr --output ${output} --mode ${lw}x${lh} --rotate ${rot} --scale 1x1`
      }

      exec(cmd, e3 => resolve(!e3))
    })
  })
})

/* ── Audio ── */
ipcMain.handle('set-audio', async (_, opts) => {
  const cfg = loadConfig()
  cfg.audio = opts
  saveConfig(cfg)
  return new Promise(resolve => {
    const vol = Math.min(100, Math.max(0, opts.volume || 80))
    /* Changer le sink par défaut si spécifié */
    const sinkName = opts.sinkName || null
    exec('which pactl', (err, pactlPath) => {
      if (!err && pactlPath.trim()) {
        const cmds = []
        if (sinkName) cmds.push(`pactl set-default-sink "${sinkName}"`)
        cmds.push(`pactl set-sink-volume @DEFAULT_SINK@ ${vol}%`)
        exec(cmds.join(' && '), e => resolve(!e))
      } else {
        exec(`amixer sset Master ${vol}%`, e => resolve(!e))
      }
    })
  })
})

/* ── Liste des sinks audio disponibles ── */
ipcMain.handle('get-audio-sinks', async () => new Promise(resolve => {
  exec('pactl list sinks 2>/dev/null', (err, out) => {
    if (err || !out) return resolve([])
    const sinks = []
    const blocks = out.split('\n\n').filter(b => b.includes('Sink #'))
    for (const block of blocks) {
      const nameMatch  = block.match(/Name:\s+(.+)/)
      const descMatch  = block.match(/Description:\s+(.+)/)
      const stateMatch = block.match(/State:\s+(.+)/)
      if (!nameMatch) continue
      sinks.push({
        name:  nameMatch[1].trim(),
        label: descMatch  ? descMatch[1].trim()  : nameMatch[1].trim(),
        state: stateMatch ? stateMatch[1].trim()  : 'UNKNOWN',
      })
    }
    resolve(sinks)
  })
}))
