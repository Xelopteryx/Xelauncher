/**
 * ipc-retropie.js
 * IPC : lancement de RetroPie / EmulationStation.
 */

'use strict'

const { ipcMain } = require('electron')
const fs           = require('fs')
const os           = require('os')
const path         = require('path')
const { exec }     = require('child_process')
const { logDebug } = require('./helpers')
const { handoffToExternal } = require('./main-window')

/**
 * Le périphérique ALSA "pulse" n'existe que si le pont ALSA<->PulseAudio
 * (paquet libasound2-plugins ou équivalent) est installé — sinon
 * audio_device="pulse" échoue silencieusement, comme le driver natif
 * avant lui. Vérification + installation best-effort, PAQUET SEULEMENT
 * (aucun fichier de config système touché, contrairement aux tentatives
 * précédentes) : fire-and-forget, ne bloque jamais le lancement.
 */
function _ensurePulseAlsaDevice() {
  exec('aplay -L 2>/dev/null | grep -qx pulse', (err) => {
    if (!err) return // déjà présent
    logDebug('Périphérique ALSA "pulse" absent — installation de libasound2-plugins')
    exec('sudo DEBIAN_FRONTEND=noninteractive apt-get install -y libasound2-plugins', (e2) => {
      logDebug(e2 ? 'Échec installation libasound2-plugins : ' + e2.message : 'libasound2-plugins installé')
    })
  })
}

/**
 * RetroArch parle par défaut à une carte ALSA matérielle par numéro
 * (audio_driver="alsa" + audio_device="hw:X,Y"), indépendante de
 * PulseAudio et de ce qui est choisi dans Réglages > Audio — d'où
 * "ça marche pour Jellyfin mais pas RetroPie".
 *
 * IMPORTANT : le driver "pulse" NATIF de RetroArch n'est souvent PAS
 * compilé dans les builds RetroPie distribuées (confirmé — plusieurs
 * sorties de "retroarch --features" listent "PulseAudio: no"). Le
 * mettre dans audio_driver ne fait alors rien : RetroArch retombe sur
 * son comportement ALSA par défaut, silencieusement — exactement le
 * symptôme observé ("balance le son dans la télé quoi qu'il arrive").
 *
 * On utilise donc plutôt le driver "alsa" (toujours présent) pointé sur
 * le périphérique ALSA nommé "pulse" — fourni automatiquement par le
 * pont ALSA<->PulseAudio (paquet libasound2-plugins ou équivalent) dès
 * qu'il est installé, exactement comme `aplay -D pulse fichier.wav`.
 * Aucun fichier système à toucher (contrairement aux tentatives
 * précédentes avec /etc/asound.conf, retirées) : entièrement scopé à ce
 * que RetroArch/EmulationStation demandent explicitement, donc zéro
 * impact sur Jellyfin.
 *
 * Réaffirmé à CHAQUE lancement (comme la ré-injection des identifiants
 * Jellyfin) car le menu Sound Settings de RetroPie/EmulationStation
 * peut réécrire ces fichiers entre deux sessions.
 */
function _ensureRetroArchPulseAudio() {
  const RA_CFG = '/opt/retropie/configs/all/retroarch.cfg'
  try {
    if (!fs.existsSync(RA_CFG)) return
    let content = fs.readFileSync(RA_CFG, 'utf8')
    let changed = false

    if (/^audio_driver\s*=/m.test(content)) {
      if (!/^audio_driver\s*=\s*"alsa"/m.test(content)) {
        content = content.replace(/^audio_driver\s*=.*$/m, 'audio_driver = "alsa"')
        changed = true
      }
    } else {
      content += '\naudio_driver = "alsa"\n'
      changed = true
    }

    if (!/^audio_device\s*=\s*"pulse"/m.test(content)) {
      if (/^audio_device\s*=/m.test(content)) {
        content = content.replace(/^audio_device\s*=.*$/m, 'audio_device = "pulse"')
      } else {
        content += '\naudio_device = "pulse"\n'
      }
      changed = true
    }

    if (changed) {
      fs.writeFileSync(RA_CFG, content)
      logDebug('retroarch.cfg : audio_driver="alsa", audio_device="pulse"')
    }
  } catch (e) {
    logDebug('Impossible de patcher retroarch.cfg : ' + e.message)
  }

  /* Même principe pour EmulationStation (sons de menu), qui a son PROPRE
     réglage séparé dans es_settings.cfg : "pulse" y est un nom de
     périphérique ALSA valide au même titre que "default"/"hw"/etc. — pas
     besoin de la redirection système /etc/asound.conf, retirée (elle
     affectait aussi Jellyfin). On ne touche le fichier que s'il existe
     déjà (ES le crée lui-même à sa 1ère fermeture). */
  try {
    const ES_CFG = path.join(os.homedir(), '.emulationstation', 'es_settings.cfg')
    if (fs.existsSync(ES_CFG)) {
      let es = fs.readFileSync(ES_CFG, 'utf8')
      if (/<string name="AudioCard" value="[^"]*"\s*\/>/.test(es) &&
          !/<string name="AudioCard" value="pulse"\s*\/>/.test(es)) {
        es = es.replace(/<string name="AudioCard" value="[^"]*"\s*\/>/, '<string name="AudioCard" value="pulse" />')
        fs.writeFileSync(ES_CFG, es)
        logDebug('es_settings.cfg : AudioCard forcé sur "pulse"')
      }
    }
  } catch (e) {
    logDebug('Impossible de patcher es_settings.cfg : ' + e.message)
  }
}

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
  _ensurePulseAlsaDevice()
  _ensureRetroArchPulseAudio()
  logDebug(`Lancement RetroPie : ${emPath}`)
  handoffToExternal(emPath)
  return true
})
