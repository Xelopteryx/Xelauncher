/**
 * xe-input-daemon.js
 * Daemon xe_input.py : démarrage, redémarrage automatique,
 * forward des événements evdev vers le renderer.
 */

'use strict'

const { ipcMain }  = require('electron')
const { spawn }    = require('child_process')
const path         = require('path')
const fs           = require('fs')
const { BASE_DIR, logDebug, ensureDirs } = require('./helpers')
const { getMainWindow }                  = require('./main-window')

let xeInputProc = null

function startXeInput() {
  if (xeInputProc) return
  const scriptPath = path.join(BASE_DIR, 'scripts', 'xe_input.py')
  if (!fs.existsSync(scriptPath)) {
    logDebug('xe_input: script absent, appel ensureDirs()')
    ensureDirs()
    if (!fs.existsSync(scriptPath)) {
      logDebug('xe_input: toujours absent après ensureDirs, abandon')
      return
    }
  }
  logDebug(`xe_input: démarrage ${scriptPath}`)
  xeInputProc = spawn('python3', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })

  let buf = ''
  xeInputProc.stdout.on('data', chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev  = JSON.parse(line)
        const win = getMainWindow()
        if (win && !win.isDestroyed()) win.webContents.send('xe-input-event', ev)
      } catch (e) {}
    }
  })

  xeInputProc.stderr.on('data', chunk => logDebug('xe_input: ' + chunk.toString().trim()))

  xeInputProc.on('exit', code => {
    logDebug(`xe_input: exit ${code}, redémarrage dans 3s`)
    xeInputProc = null
    setTimeout(startXeInput, 3000)
  })
}

function stopXeInput() {
  if (xeInputProc) {
    try { xeInputProc.kill() } catch (e) {}
    xeInputProc = null
  }
}

/* ── IPC ── */
ipcMain.handle('xe-input-status', async () => ({ running: !!xeInputProc }))

module.exports = { startXeInput, stopXeInput }
