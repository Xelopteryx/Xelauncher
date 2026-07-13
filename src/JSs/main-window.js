/**
 * main-window.js
 * Gestion de la fenêtre Electron principale et handoff vers apps externes.
 */

'use strict'

const { app, BrowserWindow, screen, powerSaveBlocker, ipcMain } = require('electron')
const path   = require('path')
const fs     = require('fs')
const { LAUNCH_NEXT_FILE, logDebug } = require('./helpers')

let mainWindow     = null
let powerBlockerId = null
let isQuitting     = false

function resolveHTML(name) {
  const candidates = [
    path.join(__dirname, '..', 'HTMLs', name),
    path.join(__dirname, name),
    path.join(__dirname, '..', name),
  ]
  return candidates.find(p => fs.existsSync(p)) || candidates[0]
}

function createWindow() {
  const { loadConfig } = require('./helpers')
  const cfg = loadConfig()
  const firstLaunch = !cfg.calibration
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width, height,
    frame:                    false,
    backgroundColor:          '#0a0a0f',
    show:                     false,
    webPreferences: {
      nodeIntegration:      false,
      contextIsolation:     true,
      backgroundThrottling: false,
      preload: path.resolve(__dirname, 'preload.js'),
    },
  })
  mainWindow.setBackgroundColor('#0a0a0f')
  mainWindow.loadFile(resolveHTML(firstLaunch ? 'calibration.html' : 'menu.html'))
  mainWindow.once('ready-to-show', () => {
  if (!mainWindow.isDestroyed()) {
    const { execSync, exec } = require('child_process')

    try { execSync('sudo /usr/bin/plymouth --update=fade') } catch (e) {}

    // Laisse le temps au fade visuel de se jouer (~0.08 par frame,
    // donc ~12-13 frames pour atteindre 0 ? ajuste selon le taux de refresh Plymouth)
    setTimeout(() => {
      try { execSync('sudo /usr/bin/plymouth quit') } catch (e) {}
    }, 400)

    mainWindow.show()
    mainWindow.focus()
    mainWindow.setFullScreen(true)
    mainWindow.setKiosk(true)
  }
})
  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
  mainWindow.webContents.on('render-process-gone', () => {
    if (isQuitting) return
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload() }, 1000)
  })
}

/**
 * Quitte Electron proprement et écrit la commande à exécuter
 * dans LAUNCH_NEXT_FILE — le wrapper shell xelauncher.sh prend le relais.
 */
function handoffToExternal(cmd) {
  logDebug(`handoffToExternal: ${cmd}`)
  isQuitting = true
  fs.writeFileSync(LAUNCH_NEXT_FILE, cmd + '\n')
  if (powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId) } catch (e) {}
    powerBlockerId = null
  }
  app.quit()
}

function getMainWindow()     { return mainWindow }
function getPowerBlockerId() { return powerBlockerId }
function setPowerBlockerId(id) { powerBlockerId = id }

module.exports = {
  resolveHTML, createWindow, handoffToExternal,
  getMainWindow, getPowerBlockerId, setPowerBlockerId,
}
