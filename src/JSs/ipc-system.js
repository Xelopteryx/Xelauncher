/**
 * ipc-system.js
 * IPC : navigation, système (reboot/shutdown/update), version, config.
 */

'use strict'

const { ipcMain } = require('electron')
const { exec, spawn } = require('child_process')
const os          = require('os')
const path        = require('path')
const { logDebug, loadConfig, saveConfig, loadProfiles, saveProfiles } = require('./helpers')
const { resolveHTML, getMainWindow } = require('./main-window')

/* ── Navigation ── */
ipcMain.handle('go-back', async () => {
  const win = getMainWindow()
  if (win) win.loadFile(resolveHTML('menu.html'))
})

ipcMain.handle('open-settings', async () => {
  const win = getMainWindow()
  if (win) win.loadFile(resolveHTML('settings.html'))
})

ipcMain.handle('save-server', async (_, serverUrl) => {
  const data = loadProfiles()
  data.server = serverUrl
  saveProfiles(data)
  return true
})

/* ── Système ── */
ipcMain.handle('system-reboot',   async () => exec('sudo systemctl reboot'))
ipcMain.handle('system-shutdown', async () => exec('sudo systemctl poweroff'))

/**
 * system-update — mise à jour APT avec progression réelle.
 * APT::Status-Fd=1 fait écrire à apt-get des lignes machine-readable
 * du type "pmstatus:<paquet>:<pourcentage>:<message>" sur stdout, ce
 * qui donne un vrai pourcentage global (téléchargement + configuration
 * confondus) sans avoir à le recalculer nous-mêmes. On l'envoie au
 * renderer via 'system-update-progress' au fil de l'eau.
 */
ipcMain.handle('system-update', async () => new Promise(resolve => {
  const win = getMainWindow()
  const sendProgress = (data) => { if (win && !win.isDestroyed()) win.webContents.send('system-update-progress', data) }

  exec('sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq', { timeout: 120000 }, () => {
    exec('apt list --upgradable 2>/dev/null | grep -vc "Listing"', (e0, totalOut) => {
      const total = parseInt((totalOut || '0').trim()) || 0
      sendProgress({ percent: 0, total })

      if (total === 0) { resolve(true); return }

      const child = spawn(
        'sudo DEBIAN_FRONTEND=noninteractive apt-get -o APT::Status-Fd=1 -o Dpkg::Use-Pty=0 upgrade -y',
        { shell: true, timeout: 600000 }
      )

      let buf = ''
      child.stdout.on('data', chunk => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          const m = line.match(/^pmstatus:([^:]*):([\d.]+):(.*)$/)
          if (!m) continue
          sendProgress({ percent: parseFloat(m[2]) || 0, total, package: m[1], message: m[3] })
        }
      })

      child.on('error', () => resolve(false))
      child.on('close', code => {
        sendProgress({ percent: 100, total })
        resolve(code === 0)
      })
    })
  })
}))

/**
 * get-system-specs — CPU / RAM / stockage / OS pour le bloc "À propos".
 */
ipcMain.handle('get-system-specs', async () => {
  const cpus     = os.cpus() || []
  const cpuModel = (cpus[0]?.model || 'Inconnu').replace(/\s+/g, ' ').trim()
  const cpuCores = cpus.length
  const ramTotal = (os.totalmem() / (1024 ** 3)).toFixed(1) + ' Go'

  const disk = await new Promise(resolve => {
    exec("df -h --output=size,used,avail,pcent / 2>/dev/null | tail -1", (err, out) => {
      if (err || !out || !out.trim()) return resolve(null)
      const parts = out.trim().split(/\s+/)
      if (parts.length < 4) return resolve(null)
      resolve({ total: parts[0], used: parts[1], avail: parts[2], pct: parts[3] })
    })
  })

  return {
    cpuModel, cpuCores, ramTotal,
    diskText: disk ? `${disk.used} / ${disk.total} (${disk.pct} utilisé)` : 'Inconnu',
    osText:   `${os.type()} ${os.release()} (${os.arch()})`,
  }
})

ipcMain.handle('get-version', async () => {
  try { return require(path.join(__dirname, 'package.json')).version } catch (e) { return '2.0.0' }
})

ipcMain.handle('check-update', async () => new Promise(resolve => {
  exec('sudo apt update -qq 2>/dev/null && apt list --upgradable 2>/dev/null | grep -vc "Listing"', (err, out) => {
    const n = parseInt(out?.trim()) || 0
    resolve({ available: n > 0, version: n + ' paquet(s)' })
  })
}))

/* ── Config ── */
ipcMain.handle('get-config', async () => loadConfig())

ipcMain.handle('save-calibration', async (_, calibData) => {
  const cfg = loadConfig()
  cfg.calibration = calibData
  saveConfig(cfg)
  return true
})

ipcMain.handle('set-controller-type', async (_, type) => {
  const cfg = loadConfig()
  cfg.controllerType = type
  saveConfig(cfg)
  return true
})
