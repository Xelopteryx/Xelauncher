/**
 * ipc-system.js
 * IPC : navigation, système (reboot/shutdown/update), version, config.
 */

'use strict'

const { ipcMain } = require('electron')
const { exec }    = require('child_process')
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

ipcMain.handle('system-update', async () => new Promise(resolve => {
  exec(
    'sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && ' +
    'sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq',
    { timeout: 600000 },
    err => resolve(!err)
  )
}))

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
