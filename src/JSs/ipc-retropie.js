/**
 * ipc-retropie.js
 * IPC : lancement de RetroPie / EmulationStation.
 */

'use strict'

const { ipcMain } = require('electron')
const fs          = require('fs')
const { logDebug } = require('./helpers')
const { handoffToExternal } = require('./main-window')

ipcMain.handle('launch-retropie', async () => {
  const emPaths = [
    '/usr/bin/emulationstation',
    '/opt/retropie/supplementary/emulationstation/emulationstation',
  ]
  const emPath = emPaths.find(p => fs.existsSync(p))
  if (!emPath) {
    logDebug('EmulationStation introuvable')
    return false
  }
  logDebug(`Lancement RetroPie : ${emPath}`)
  handoffToExternal(emPath)
  return true
})
