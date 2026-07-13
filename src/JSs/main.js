/**
 * XeLauncher — main.js
 * Point d'entrée Electron. Ne contient que le bootstrap :
 * chargement des modules, création de la fenêtre, démarrage du daemon.
 *
 * Stratégie de lancement RetroArch / Jellyfin :
 *   On QUITTE Electron proprement avant de spawner l'application,
 *   puis le script wrapper xelauncher.sh relance Electron au retour.
 *   Cela laisse les ressources X11/GPU entièrement libres.
 */

'use strict'

const { app } = require('electron')
const fs      = require('fs')

console.log('__dirname:', __dirname)
console.log('argv1:', process.argv[1])

/* ── Modules (ordre obligatoire : helpers en premier) ── */
const {
  ensureDirs, getOrCreateSecretKey, LAUNCH_NEXT_FILE,
} = require('./helpers')

const { createWindow, setPowerBlockerId } = require('./main-window')
const { startXeInput, stopXeInput }         = require('./xe-input-daemon')

/* Enregistrement des handlers IPC — l'ordre n'a pas d'importance ici */
require('./ipc-system')
require('./ipc-display')
require('./ipc-network')
require('./ipc-bluetooth')
require('./ipc-retropie')
require('./ipc-jellyfin')

/* ── Démarrage ──
   Le splash s'affiche en tout premier (avant ensureDirs/getOrCreateSecretKey)
   pour que le bootstrap entier soit couvert, pas seulement la création
   de la fenêtre du menu. Chaque étape envoie sa progression au splash;
   transitionToMenu() bascule vers le vrai menu une fois tout prêt,
   dans la même fenêtre (pas de flash). */
app.whenReady().then(() => {
  createWindow()

  ensureDirs()
  getOrCreateSecretKey()

  try { fs.unlinkSync(LAUNCH_NEXT_FILE) } catch (e) {}

  setTimeout(startXeInput, 2000)
})

app.on('window-all-closed', () => {
  // Ne PAS appeler app.quit() ici : le wrapper xelauncher.sh gère le cycle de vie
})

app.on('before-quit', stopXeInput)
