/**
 * XeLauncher — main.js
 * Electron main process
 *
 * Stratégie de lancement RetroArch / Jellyfin :
 *   On QUITTE Electron proprement avant de spawner l'application,
 *   puis le script wrapper xelauncher.sh relance Electron au retour.
 *   Cela laisse les ressources X11/GPU entièrement libres.
 */

const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker } = require('electron')
const path = require('path')
console.log("__dirname:", __dirname); console.log("argv1:", process.argv[1]);
const { exec, spawn, execSync } = require('child_process')
const http = require('http')
const https = require('https')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

/* ── Secret key (chiffrement des mots de passe) ──────────────────────────── */
const SECRET_KEY_FILE = path.join(os.homedir(), 'xelauncher', '.secret.key')
let SECRET_KEY = null

function getOrCreateSecretKey() {
  if (SECRET_KEY) return SECRET_KEY
  try {
    SECRET_KEY = fs.existsSync(SECRET_KEY_FILE)
      ? fs.readFileSync(SECRET_KEY_FILE, 'utf8')
      : (() => {
        const k = crypto.randomBytes(32).toString('hex')
        fs.mkdirSync(path.dirname(SECRET_KEY_FILE), { recursive: true })
        fs.writeFileSync(SECRET_KEY_FILE, k)
        return k
      })()
  } catch (e) {
    SECRET_KEY = 'xelauncher-static-key-fallback-2024'
  }
  return SECRET_KEY
}

function encrypt(text) {
  if (!text) return ''
  try {
    const key = getOrCreateSecretKey().padEnd(32, '0').slice(0, 32)
    const iv = crypto.randomBytes(16)
    const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv)
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()])
    return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + enc.toString('hex')
  } catch (e) { return text }
}

function decrypt(text) {
  if (!text) return ''
  try {
    const parts = text.split(':')
    if (parts.length !== 3) return text
    const key = getOrCreateSecretKey().padEnd(32, '0').slice(0, 32)
    const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(parts[0], 'hex'))
    d.setAuthTag(Buffer.from(parts[1], 'hex'))
    return d.update(Buffer.from(parts[2], 'hex'), null, 'utf8') + d.final('utf8')
  } catch (e) { return text }
}

/* ── Paths ─────────────────────────────────────────────────────────────────── */
const BASE_DIR = path.join(os.homedir(), 'xelauncher')
const PROFILES_PATH = path.join(BASE_DIR, 'profiles.json')
const AVATARS_PATH = path.join(BASE_DIR, 'src/AVATARs')
const CONFIG_PATH = path.join(BASE_DIR, 'config.json')
const LOG_PATH = path.join(BASE_DIR, 'jellyfin_debug.log')

/* Fichier de séquence de lancement : l'app à démarrer après que
   XeLauncher se ferme. Le script wrapper lit ce fichier. */
const LAUNCH_NEXT_FILE = '/tmp/xelauncher-launch-next'

/* ── Helpers ────────────────────────────────────────────────────────────────── */
function logDebug(msg) {
  const ts = new Date().toISOString()
  try { fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`) } catch (e) { }
  console.log(msg)
}

function ensureDirs() {
  [BASE_DIR, AVATARS_PATH].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) })
  // Écrire xe_input.py au démarrage
  const scriptsDir = path.join(BASE_DIR, 'scripts')
  try {
    fs.mkdirSync(scriptsDir, { recursive: true })
    const xeInputPath = path.join(scriptsDir, 'xe_input.py')
    const xeInputContent = `#!/usr/bin/env python3
# xe_input.py — Lecteur evdev universel pour XeLauncher Prometheus
import os, sys, json, glob, threading, time
try:
    from evdev import InputDevice, ecodes
except ImportError:
    sys.stderr.write("pip install evdev\\n"); sys.exit(1)

# Sous-nœuds parasites à ignorer — on exclut uniquement les nodes qui
# n'ont PAS de touches utiles (audio, capteurs, souris, IR, etc.)
# Note : 'ir ' avec espace pour ne pas exclure les télécommandes IR principales
EXCLUDE = {
    'vc4','hdmi','jack','power','pwr','accel','ir ','gyro','motion plus','touchscreen',
    'system control','consumer control','mouse','touchpad','motion sensor','motion sensors',
}

# Pas de déduplication par nom : on surveille TOUS les nodes non-exclus,
# même si plusieurs partagent le même nom (ex: XING WEI a deux nodes utiles).
# Le device envoyé au renderer est le chemin /dev/input/eventN (unique).

KEY_MAP = {
    103:'up', 108:'down', 105:'left', 106:'right',
    28:'confirm', 1:'back', 14:'back',
    0x130:'confirm', 0x131:'back',  0x132:'action', 0x133:'action',
    0x134:'action',  0x135:'action',
    0x136:'l1', 0x137:'r1', 0x138:'l2', 0x139:'r2',
    0x13a:'select', 0x13b:'menu', 0x13c:'menu', 0x13d:'l3', 0x13e:'r3',
    0x101:'confirm', 0x102:'back', 0x197:'menu', 0x19c:'select',
    0x8b:'menu', 0x66:'confirm', 0x9e:'back', 0xa4:'confirm',
    0x160:'confirm', 0x161:'select', 0x166:'menu', 0xe3:'back',
    0x110:'confirm', 0x111:'back', 0x112:'menu',
}
ABS_MAP = {
    0:('left','right'), 1:('up','down'), 2:('left','right'), 5:('up','down'),
    16:('left','right'), 17:('up','down'), 18:('left','right'), 19:('up','down'),
}
REL_MAP = {0:('left','right'), 1:('up','down'), 8:('left','right'), 11:('up','down')}
REL_THRESHOLD = 8

def send(device, action, raw=None):
    sys.stdout.write(json.dumps({'device':device,'action':action,'raw':raw or action})+'\\n')
    sys.stdout.flush()

def should_exclude(name):
    nl = name.lower()
    return any(x in nl for x in EXCLUDE)

def watch(dev_path, stop_event):
    try:
        dev = InputDevice(dev_path)
        dev_name = dev.name
        if should_exclude(dev_name):
            print(f'[xe_input] SKIP (excluded) {dev_name}', file=sys.stderr, flush=True); return
        # Utiliser dev_path comme identifiant unique (évite les collisions de noms)
        print(f'[xe_input] WATCH {dev_name} @ {dev_path}', file=sys.stderr, flush=True)
        axis_state = {}; axis_range = {}; rel_acc = {}; axis_time = {}
        caps = dev.capabilities()
        if ecodes.EV_ABS in caps:
            for code, info in caps[ecodes.EV_ABS]:
                if hasattr(info,'min') and hasattr(info,'max'):
                    axis_range[code] = (info.min, info.max)
        COOL = 0.15
        for event in dev.read_loop():
            if stop_event.is_set(): break
            if event.type == ecodes.EV_KEY and event.value == 1:
                action = KEY_MAP.get(event.code)
                if action: send(dev_path, action, f'KEY_{event.code}')
            elif event.type == ecodes.EV_ABS and event.code in ABS_MAP:
                rng = axis_range.get(event.code, (-32767,32767))
                mn,mx = rng; mid=(mn+mx)/2; span=(mx-mn)/2 or 1
                norm=(event.value-mid)/span; DEAD=0.25
                neg_act,pos_act = ABS_MAP[event.code]
                now=time.monotonic(); last_t=axis_time.get(event.code,0)
                if abs(norm)<DEAD: axis_state[event.code]=None
                elif norm<-DEAD and axis_state.get(event.code)!=neg_act and now-last_t>COOL:
                    axis_state[event.code]=neg_act; axis_time[event.code]=now
                    send(dev_path, neg_act, f'ABS_{event.code}_neg')
                elif norm>DEAD and axis_state.get(event.code)!=pos_act and now-last_t>COOL:
                    axis_state[event.code]=pos_act; axis_time[event.code]=now
                    send(dev_path, pos_act, f'ABS_{event.code}_pos')
            elif event.type == ecodes.EV_REL and event.code in REL_MAP:
                rel_acc[event.code] = rel_acc.get(event.code,0)+event.value
                neg_act,pos_act = REL_MAP[event.code]
                if rel_acc[event.code]<=-REL_THRESHOLD:
                    send(dev_path, neg_act, f'REL_{event.code}_neg'); rel_acc[event.code]=0
                elif rel_acc[event.code]>=REL_THRESHOLD:
                    send(dev_path, pos_act, f'REL_{event.code}_pos'); rel_acc[event.code]=0
    except Exception as e:
        print(f'[xe_input] Error {dev_path}: {e}', file=sys.stderr, flush=True)

def main():
    threads={}; stop_events={}
    while True:
        current=set(glob.glob('/dev/input/event*'))
        for dev_path in current:
            if dev_path not in threads or not threads[dev_path].is_alive():
                stop_ev=threading.Event()
                t=threading.Thread(target=watch,args=(dev_path,stop_ev),daemon=True)
                t.start(); threads[dev_path]=t; stop_events[dev_path]=stop_ev
        for dev_path in list(threads.keys()):
            if dev_path not in current:
                stop_events[dev_path].set(); del threads[dev_path]; del stop_events[dev_path]
        time.sleep(3)

if __name__=='__main__': main()
`
    fs.writeFileSync(xeInputPath, xeInputContent, { mode: 0o755 })
  } catch(e) { logDebug('ensureDirs xe_input error: ' + e.message) }
}

function loadJSON(p, def) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { }
  return def
}

function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}

function loadConfig() { return loadJSON(CONFIG_PATH, { controllerType: 'generic' }) }
function saveConfig(data) { saveJSON(CONFIG_PATH, data) }

function loadProfiles() {
  const data = loadJSON(PROFILES_PATH, { server: '', profiles: [] })
  if (data.profiles) data.profiles = data.profiles.map(p => ({ ...p, password: decrypt(p.password || '') }))
  return data
}

function saveProfiles(data) {
  saveJSON(PROFILES_PATH, {
    server: data.server,
    profiles: data.profiles.map(p => ({ ...p, password: encrypt(p.password || '') }))
  })
}

/* ── Window ─────────────────────────────────────────────────────────────────── */
let mainWindow = null
let powerBlockerId = null

function resolveHTML(name) {
  // Supporte deux layouts : src/HTMLs/name.html  OU  name.html à la racine
  const candidates = [
    path.join(__dirname, '..', 'HTMLs', name),
    path.join(__dirname, name),
    path.join(__dirname, '..', name),
  ]
  return candidates.find(p => fs.existsSync(p)) || candidates[0]
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  mainWindow = new BrowserWindow({
    width, height,
    fullscreen: true,
    frame: false,
    kiosk: true,
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: require('path').resolve(__dirname, 'preload.js')
    }
  })

  mainWindow.loadFile(resolveHTML('menu.html'))
  mainWindow.once("ready-to-show", () => { mainWindow.show(); mainWindow.focus(); })

  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')

  mainWindow.webContents.on('render-process-gone', () => {
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload() }, 1000)
  })
}

app.whenReady().then(() => {
  ensureDirs()
  getOrCreateSecretKey()
  // Nettoyer les fichiers résiduels
  try { fs.unlinkSync(LAUNCH_NEXT_FILE) } catch (e) { }
  createWindow()
})

app.on('window-all-closed', () => {
  if (powerBlockerId !== null) powerSaveBlocker.stop(powerBlockerId)
  // Ne PAS appeler app.quit() ici : le wrapper gère tout
})

/* ── Navigation ──────────────────────────────────────────────────────────────── */
ipcMain.handle('go-back', async () => {
  if (mainWindow) mainWindow.loadFile(resolveHTML('menu.html'))
})

ipcMain.handle('open-settings', async () => {
  if (mainWindow) mainWindow.loadFile(resolveHTML('settings.html'))
})

ipcMain.handle('save-server', async (_, serverUrl) => {
  const data = loadProfiles(); data.server = serverUrl; saveProfiles(data); return true
})

/* ── Fonction centrale : quitter Electron et lancer une commande ────────────── */
/**
 * Lance `cmd` (shell) en écrivant d'abord LAUNCH_NEXT_FILE,
 * puis quitte Electron proprement.
 * Le wrapper script lit ce fichier, attend la fin du process, puis
 * relance Electron.
 *
 * Format du fichier : première ligne = commande shell complète
 */
function handoffToExternal(cmd) {
  logDebug(`handoffToExternal: ${cmd}`)

  // Écrire la commande pour le wrapper
  fs.writeFileSync(LAUNCH_NEXT_FILE, cmd + '\n')

  // Quitter Electron — le wrapper prend le relais
  if (powerBlockerId !== null) {
    try { powerSaveBlocker.stop(powerBlockerId) } catch (e) { }
    powerBlockerId = null
  }
  app.quit()
}

/* ── Script wrapper (écrit au premier lancement si absent) ───────────────────── */
/**
 * Ce script est à déposer dans ~/xelauncher/xelauncher.sh
 * et à appeler depuis autostart / .bashrc au lieu d'appeler electron directement.
 *
 * Contenu suggéré (pour info, pas écrit automatiquement par cet handler) :
 *
 * #!/bin/bash
 * XELAUNCHER_DIR="$HOME/xelauncher"
 * LAUNCH_FILE="/tmp/xelauncher-launch-next"
 * while true; do
 *   rm -f "$LAUNCH_FILE"
 *   electron "$XELAUNCHER_DIR/src/main.js" --no-sandbox
 *   if [ -f "$LAUNCH_FILE" ]; then
 *     CMD=$(cat "$LAUNCH_FILE")
 *     rm -f "$LAUNCH_FILE"
 *     eval "$CMD"
 *   else
 *     break
 *   fi
 * done
 */

/* ── RetroArch / RetroPie ────────────────────────────────────────────────────── */
ipcMain.handle('launch-retropie', async () => {
  const emPaths = [
    '/usr/bin/emulationstation',
    '/opt/retropie/supplementary/emulationstation/emulationstation'
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

/* ── Jellyfin ────────────────────────────────────────────────────────────────── */
ipcMain.handle('launch-jellyfin', async () => {
  // Démarrer Tailscale si disponible, puis afficher les profils
  await new Promise(resolve => {
    exec('which tailscale', err => {
      if (err) return resolve()
      exec('sudo systemctl start tailscaled 2>/dev/null', () => {
        exec('sudo tailscale up 2>/dev/null', () => resolve())
      })
    })
  })
  if (mainWindow) mainWindow.loadFile(resolveHTML('profiles.html'))
})

ipcMain.handle('launch-jellyfin-token', async (_, server, token, userId, serverId) => {
  logDebug('=== LANCEMENT JELLYFIN ===')
  logDebug(`Server: ${server}  UserId: ${userId}  ServerId: ${serverId}`)

  const BASE_DIR = path.join(os.homedir(), 'xelauncher')
  const SCRIPTS_DIR = path.join(BASE_DIR, 'scripts')
  const MAPS_FILE = path.join(BASE_DIR, 'inputmaps.json')
  const JMP_WRAPPER = path.join(SCRIPTS_DIR, 'jmp_wrapper.sh')
  const EVDEV_SCRIPT = path.join(SCRIPTS_DIR, 'xe_input.py')

  // ── Script evdev : défini et écrit par ensureDirs() au démarrage ──────────
  // Plus de duplication ici. On s'assure juste que le fichier est présent.
  try {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
    if (!fs.existsSync(EVDEV_SCRIPT)) ensureDirs()
    logDebug('Script evdev présent')
  } catch (e) { logDebug(`Erreur vérif evdev: ${e.message}`) }

  const cleanServer = server.replace(/\/+$/, '')

  // ── 1. Fichier jellyfin_credentials (utilisé par JMP pour savoir à quel serveur se connecter) ──
  const jmpCredsCandidates = [
    path.join(os.homedir(), '.var/app/com.github.iwalton3.jellyfin-media-player/data/jellyfinmediaplayer/jellyfin_credentials'),
    path.join(os.homedir(), '.local/share/jellyfinmediaplayer/jellyfin_credentials'),
  ]
  const jmpCredsFile = jmpCredsCandidates.find(p => {
    try { fs.accessSync(path.dirname(p)); return true } catch (e) { return false }
  }) || jmpCredsCandidates[0]

  const jmpCreds = JSON.stringify({
    Servers: [{
      ManualAddress: cleanServer,
      Id: serverId || 'xelauncher',
      UserId: userId || '',
      AccessToken: token,
      LastConnectionMode: 2,
      LastLocalAddress: cleanServer,
    }]
  })

  try {
    fs.mkdirSync(path.dirname(jmpCredsFile), { recursive: true })
    fs.writeFileSync(jmpCredsFile, jmpCreds, 'utf8')
    logDebug(`jellyfin_credentials écrit dans ${jmpCredsFile}`)
  } catch (e) {
    logDebug(`Erreur écriture jellyfin_credentials: ${e.message}`)
  }

  // ── 2. Injection LevelDB (localStorage du web client Jellyfin) ──
  // Le web client lit jellyfin_credentials depuis deux clés LevelDB :
  //   _http://SERVER\x00\x01jellyfin_credentials  (session active)
  //   _file://\x00\x01jellyfin_credentials         (session find-webclient)
  const leveldbScript = `
import plyvel, json, time, os, sys

SERVER    = ${JSON.stringify(cleanServer)}
TOKEN     = ${JSON.stringify(token)}
USER_ID   = ${JSON.stringify(userId || '')}
SERVER_ID = ${JSON.stringify(serverId || '')}

now_ms = int(time.time() * 1000)

# Format complet utilisé par le web client Jellyfin (clé principale)
creds_main = json.dumps({
    "Servers": [{
        "DateLastAccessed":   now_ms,
        "LastConnectionMode": 2,
        "ManualAddress":      SERVER,
        "manualAddressOnly":  True,
        "Id":                 SERVER_ID,
        "AccessToken":        TOKEN,
        "UserId":             USER_ID,
    }]
}, separators=(',', ':'))

# Format simple pour find-webclient (clé file://)
creds_file = json.dumps({
    "Servers": [{
        "ManualAddress":      SERVER,
        "Id":                 SERVER_ID,
        "UserId":             USER_ID,
        "AccessToken":        TOKEN,
        "LastConnectionMode": 2,
        "LastLocalAddress":   SERVER,
    }]
})

candidates = [
    os.path.expanduser("~/.var/app/com.github.iwalton3.jellyfin-media-player/data/Jellyfin Media Player/QtWebEngine/Default/Local Storage/leveldb"),
    os.path.expanduser("~/.local/share/Jellyfin Media Player/QtWebEngine/Default/Local Storage/leveldb"),
]
db_path = next((p for p in candidates if os.path.exists(p)), None)
if not db_path:
    print("[leveldb] Base LevelDB introuvable", flush=True)
    sys.exit(1)

db = plyvel.DB(db_path)
key_main = b"_" + SERVER.encode() + b"\\x00\\x01jellyfin_credentials"
key_file = b"_file://\\x00\\x01jellyfin_credentials"
db.put(key_main, b"\\x01" + creds_main.encode())
db.put(key_file, b"\\x01" + creds_file.encode())
db.close()
print("[leveldb] OK - injecté pour userId=" + USER_ID, flush=True)
`

  await new Promise(resolve => {
    const tmp = path.join(os.tmpdir(), 'xe_leveldb.py')
    fs.writeFileSync(tmp, leveldbScript)
    exec(`python3 "${tmp}"`, (err, out) => {
      logDebug(out ? out.trim() : '')
      if (err) logDebug(`LevelDB err: ${err.message}`)
      resolve()
    })
  })

  const jmpUrl = `${cleanServer}/web/index.html#!/home.html?serverId=${serverId || ''}&userId=${userId || ''}&apiKey=${token}`

  const JF_MAPPING_FILE = path.join(BASE_DIR, 'jfmapping.json')
  const JMP_INPUT_SCRIPT = path.join(SCRIPTS_DIR, 'xe_jmp_input.py')

  // Écrire xe_jmp_input.py
  try {
    fs.writeFileSync(JMP_INPUT_SCRIPT, buildJmpInputScript(), { mode: 0o755 })
    logDebug('xe_jmp_input.py écrit')
  } catch (e) { logDebug(`Erreur écriture xe_jmp_input: ${e.message}`) }

  const wrapperContent = `#!/bin/bash
JMP_INPUT_SCRIPT="${JMP_INPUT_SCRIPT}"
JF_MAPPING_FILE="${JF_MAPPING_FILE}"
JMP_URL='${jmpUrl}'
REMAP_PID=""
if command -v python3 >/dev/null && [ -f "$JMP_INPUT_SCRIPT" ]; then
  python3 "$JMP_INPUT_SCRIPT" "$JF_MAPPING_FILE" &
  REMAP_PID=$!
fi
# Lancer JMP en plein écran
flatpak run com.github.iwalton3.jellyfin-media-player --fullscreen "$JMP_URL"
if [ -n "$REMAP_PID" ]; then
  kill "$REMAP_PID" 2>/dev/null
  wait "$REMAP_PID" 2>/dev/null
fi
`

  try {
    fs.writeFileSync(JMP_WRAPPER, wrapperContent, { mode: 0o755 })
    logDebug('Wrapper JMP écrit')
  } catch (e) { logDebug(`Erreur écriture wrapper: ${e.message}`) }

  handoffToExternal(`bash "${JMP_WRAPPER}"`)
  return true
})

/* ── Script Python de remapping input pour JMP ──────────────────────────────── */
/**
 * Ce script tourne en arrière-plan pendant JMP.
 * Il lit les événements bruts de tous les joysticks via /dev/input/,
 * les traduit via la table de mapping XeInput (inputmaps.json),
 * et envoie les touches clavier correspondantes à JMP via xdotool.
 * Les events joystick natifs ne sont PAS forwarded à JMP (grab exclusif),
 * ce qui empêche tout doublon d'input.
 */
function buildJmpInputScript() {
  return `#!/usr/bin/env python3
# xe_jmp_input.py -- Remapping evdev -> xdotool pour Jellyfin Media Player
# Lit /dev/input/event* (evdev pur), traduit via jfmapping.json,
# et envoie les touches clavier à JMP via xdotool.
import sys, os, json, threading, time, glob, subprocess
try:
    from evdev import InputDevice, ecodes
except ImportError:
    sys.stderr.write("pip install evdev\\n"); sys.exit(1)

JF_MAPPING_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/xelauncher/jfmapping.json')

# Sous-devices à ignorer (même logique que xe_input.py)
EXCLUDE = {
    'vc4','hdmi','jack','power','pwr','accel','ir ','gyro',
    'motion plus','touchscreen','system control','consumer control',
    'mouse','touchpad','motion sensor','motion sensors',
}

# Devices non mappables (IR, capteurs) — ne pas écouter leurs touches
UNMAPPABLE = ['ir','sensor','motion','accelero','gyro','touchpad','touch pad','nunchuk extension']

# Actions XeInput -> touche xdotool pour JMP
# La valeur par défaut est utilisée si aucun mapping n'est configuré.
JF_DEFAULTS = {
    'jf_up':    'Up',
    'jf_down':  'Down',
    'jf_left':  'Left',
    'jf_right': 'Right',
    'jf_ok':    'Return',
    'jf_back':  'Escape',
    'jf_menu':  'm',
    'jf_prev':  'j',
    'jf_next':  'l',
}

# Actions XeInput navigation -> action_id JF (pour résolution via inputmaps.json)
NAV_TO_JF = {
    'up':      'jf_up',
    'down':    'jf_down',
    'left':    'jf_left',
    'right':   'jf_right',
    'confirm': 'jf_ok',
    'back':    'jf_back',
    'menu':    'jf_menu',
    'select':  'jf_menu',
}

# Keycodes evdev -> action XeInput (même table que xe_input.py)
KEY_MAP = {
    103:'up', 108:'down', 105:'left', 106:'right',
    28:'confirm', 1:'back', 14:'back',
    0x130:'confirm', 0x131:'back',  0x132:'action', 0x133:'action',
    0x134:'action',  0x135:'action',
    0x136:'l1', 0x137:'r1', 0x138:'l2', 0x139:'r2',
    0x13a:'select', 0x13b:'menu', 0x13c:'menu', 0x13d:'l3', 0x13e:'r3',
    0x101:'confirm', 0x102:'back', 0x197:'menu', 0x19c:'select',
    0x8b:'menu', 0x66:'confirm', 0x9e:'back', 0xa4:'confirm',
    0x160:'confirm', 0x161:'select', 0x166:'menu', 0xe3:'back',
    0x110:'confirm', 0x111:'back', 0x112:'menu',
}
ABS_MAP = {
    0:('left','right'), 1:('up','down'), 2:('left','right'), 5:('up','down'),
    16:('left','right'), 17:('up','down'),
}

_mapping_cache = [None]
_mapping_mtime = [0]

def load_mapping():
    try:
        mtime = os.path.getmtime(JF_MAPPING_FILE)
        if _mapping_cache[0] is None or mtime != _mapping_mtime[0]:
            with open(JF_MAPPING_FILE) as f:
                _mapping_cache[0] = json.load(f)
            _mapping_mtime[0] = mtime
        return _mapping_cache[0]
    except Exception:
        return {}

def build_raw_to_jf(mapping):
    """
    Construit un dict inverse : raw (ex: 'KEY_304') -> touche xdotool JF.
    Le mapping stocke { jf_ok: 'KEY_304', jf_back: 'KEY_305', ... }
    On construit { 'KEY_304': 'Return', 'KEY_305': 'Escape', ... }
    """
    result = {}
    for jf_id, raw in mapping.items():
        if jf_id.startswith('__'): continue
        xdo = JF_DEFAULTS.get(jf_id)
        if xdo and raw:
            result[raw] = xdo
    return result

def resolve_action(xe_action, mapping):
    """Fallback : convertit une action XeInput résolue en touche JMP via les défauts."""
    jf_id = NAV_TO_JF.get(xe_action)
    if not jf_id: return None
    return JF_DEFAULTS.get(jf_id)

def send_key(key):
    if not key:
        return
    try:
        subprocess.run(['xdotool', 'key', '--clearmodifiers', key],
                       timeout=0.2, capture_output=True)
    except Exception as e:
        print('[xe_jmp_input] xdotool error: ' + str(e), flush=True)

def should_exclude(name):
    nl = name.lower()
    return any(x in nl for x in EXCLUDE)

def is_unmappable(name):
    nl = name.lower()
    return any(x in nl for x in UNMAPPABLE)

_name_seen = {}
_name_seen_lock = threading.Lock()

def claim_device(name, dev_path):
    key = name.strip().lower()
    def event_num(p):
        try: return int(p.replace('/dev/input/event',''))
        except: return 999
    with _name_seen_lock:
        if key not in _name_seen:
            _name_seen[key] = dev_path; return True
        if event_num(dev_path) < event_num(_name_seen[key]):
            _name_seen[key] = dev_path; return True
        return False

def release_device(name, dev_path):
    key = name.strip().lower()
    with _name_seen_lock:
        if _name_seen.get(key) == dev_path:
            del _name_seen[key]

def watch(dev_path, stop_event):
    dev_name = None
    try:
        dev = InputDevice(dev_path)
        dev_name = dev.name
        if should_exclude(dev_name) or is_unmappable(dev_name):
            return
        if not claim_device(dev_name, dev_path):
            return
        print(f'[xe_jmp_input] WATCH {dev_name} @ {dev_path}', flush=True)
        axis_state = {}; axis_range = {}; axis_time = {}
        caps = dev.capabilities()
        if ecodes.EV_ABS in caps:
            for code, info in caps[ecodes.EV_ABS]:
                if hasattr(info,'min') and hasattr(info,'max'):
                    axis_range[code] = (info.min, info.max)
        COOL = 0.18
        for event in dev.read_loop():
            if stop_event.is_set(): break
            mapping = load_mapping()
            raw_map = build_raw_to_jf(mapping)
            has_custom = bool(raw_map)
            if event.type == ecodes.EV_KEY and event.value == 1:
                raw = f'KEY_{event.code}'
                if has_custom:
                    key = raw_map.get(raw)
                    if key: send_key(key)
                else:
                    xe_action = KEY_MAP.get(event.code)
                    if xe_action: send_key(resolve_action(xe_action, mapping))
            elif event.type == ecodes.EV_ABS and event.code in ABS_MAP:
                rng = axis_range.get(event.code, (-32767,32767))
                mn,mx = rng; mid=(mn+mx)/2; span=(mx-mn)/2 or 1
                norm=(event.value-mid)/span; DEAD=0.25
                neg_act,pos_act = ABS_MAP[event.code]
                now=time.monotonic(); last_t=axis_time.get(event.code,0)
                if abs(norm)<DEAD: axis_state[event.code]=None
                elif norm<-DEAD and axis_state.get(event.code)!=neg_act and now-last_t>COOL:
                    axis_state[event.code]=neg_act; axis_time[event.code]=now
                    raw = f'ABS_{event.code}_neg'
                    key = raw_map.get(raw) if has_custom else resolve_action(neg_act, mapping)
                    if key: send_key(key)
                elif norm>DEAD and axis_state.get(event.code)!=pos_act and now-last_t>COOL:
                    axis_state[event.code]=pos_act; axis_time[event.code]=now
                    raw = f'ABS_{event.code}_pos'
                    key = raw_map.get(raw) if has_custom else resolve_action(pos_act, mapping)
                    if key: send_key(key)
    except Exception as e:
        print(f'[xe_jmp_input] Error {dev_path}: {e}', flush=True)
    finally:
        if dev_name: release_device(dev_name, dev_path)

def main():
    threads={}; stop_events={}
    while True:
        current=set(glob.glob('/dev/input/event*'))
        for dev_path in current:
            if dev_path not in threads or not threads[dev_path].is_alive():
                stop_ev=threading.Event()
                t=threading.Thread(target=watch,args=(dev_path,stop_ev),daemon=True)
                t.start(); threads[dev_path]=t; stop_events[dev_path]=stop_ev
        for dev_path in list(threads.keys()):
            if dev_path not in current:
                stop_events[dev_path].set(); del threads[dev_path]; del stop_events[dev_path]
        time.sleep(3)

if __name__=='__main__': main()
`
}

/* ── Auth Jellyfin ─────────────────────────────────────────────────────────── */
ipcMain.handle('jellyfin-authenticate', async (_, server, username, password) => {
  logDebug(`Auth: ${username} → ${server}`)
  return new Promise(resolve => {
    try {
      const u = new URL(server + '/Users/AuthenticateByName')
      const body = JSON.stringify({ Username: username, Pw: password })
      const lib = u.protocol === 'https:' ? https : http
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Emby-Authorization': 'MediaBrowser Client="XeLauncher", Device="RPI5", DeviceId="xelauncher-rpi5", Version="2.0.0"'
        }
      }, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try {
            const j = JSON.parse(data)
            if (j.AccessToken) {
              resolve({ ok: true, accessToken: j.AccessToken, userId: j.User?.Id, userName: j.User?.Name, serverId: j.ServerId })
            } else {
              resolve({ ok: false, error: j.message || 'Authentification refusée' })
            }
          } catch (e) { resolve({ ok: false, error: 'Réponse invalide' }) }
        })
      })
      req.on('error', e => resolve({ ok: false, error: e.message }))
      req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'Délai dépassé' }) })
      req.write(body); req.end()
    } catch (e) { resolve({ ok: false, error: 'URL invalide' }) }
  })
})

/* ── Profils ────────────────────────────────────────────────────────────────── */
ipcMain.handle('get-profiles', async () => loadProfiles())

ipcMain.handle('save-profile', async (_, profile) => {
  const data = loadProfiles()
  const idx = data.profiles.findIndex(p => p.id === profile.id)
  if (idx >= 0) data.profiles[idx] = profile; else data.profiles.push(profile)
  saveProfiles(data); return true
})

ipcMain.handle('delete-profile', async (_, id) => {
  const data = loadProfiles()
  data.profiles = data.profiles.filter(p => p.id !== id)
  saveProfiles(data); return true
})

ipcMain.handle('get-avatars', async () => {
  try { if (fs.existsSync(AVATARS_PATH)) return fs.readdirSync(AVATARS_PATH).filter(f => /\.(png|jpg|jpeg)$/i.test(f)) }
  catch (e) { }
  return []
})

ipcMain.handle('get-avatar-data', async (_, filename) => {
  try {
    if (!filename || filename.startsWith('builtin_')) return null
    const p = path.join(AVATARS_PATH, filename)
    if (!fs.existsSync(p)) return null
    const data = fs.readFileSync(p)
    const ext = path.extname(filename).toLowerCase().replace('.', '')
    return `data:image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : 'png'};base64,${data.toString('base64')}`
  } catch (e) { return null }
})

/* ── Système ────────────────────────────────────────────────────────────────── */
ipcMain.handle('system-reboot', async () => exec('sudo systemctl reboot'))
ipcMain.handle('system-shutdown', async () => exec('sudo systemctl poweroff'))

ipcMain.handle('system-update', async () => new Promise(resolve => {
  exec('sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq',
    { timeout: 600000 }, err => resolve(!err))
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

/* ── Config ─────────────────────────────────────────────────────────────────── */
ipcMain.handle('get-config', async () => loadConfig())
ipcMain.handle('set-controller-type', async (_, type) => {
  const cfg = loadConfig(); cfg.controllerType = type; saveConfig(cfg); return true
})

/* ── Affichage ─────────────────────────────────────────────────────────────── */
ipcMain.handle('set-display', async (_, opts) => {
  const cfg = loadConfig(); cfg.display = opts; saveConfig(cfg)
  return new Promise(resolve => {
    const res = (opts.resolution || '1920x1080').replace(/[×x×]/g, 'x')
    const [w, h] = res.split('x').map(Number)
    const rate = parseInt(opts.refresh) || 60
    const rotMap = { '0°': 'normal', '90°': 'left', '180°': 'inverted', '270°': 'right' }
    const rot = rotMap[opts.rotation] || 'normal'
    exec('which xrandr', err => {
      if (!err) {
        exec("xrandr | grep ' connected' | awk '{print $1}' | head -1", (e, out) => {
          const output = (out || '').trim() || 'HDMI-1'
          exec(`xrandr --output ${output} --mode ${w}x${h} --rate ${rate} --rotate ${rot}`, e3 => resolve(!e3))
        })
      } else {
        exec(`sudo raspi-config nonint do_resolution ${w} ${h}`, e4 => resolve(!e4))
      }
    })
  })
})

ipcMain.handle('get-display-modes', async () => new Promise(resolve => {
  exec('which xrandr', err => {
    if (err) return resolve({ resolutions: [], refreshRates: [] })
    exec("xrandr | grep ' connected' | awk '{print $1}' | head -1", (e, out) => {
      const output = (out || '').trim() || 'HDMI-1'
      exec(`xrandr --query`, (e2, xout) => {
        if (e2 || !xout) return resolve({ resolutions: [], refreshRates: [] })
        // Parser les modes de l'écran connecté
        const lines = xout.split('\n')
        let inOutput = false
        const resSeen = new Set()
        const rateSeen = new Set()
        const resolutions = []
        const refreshRates = []
        for (const line of lines) {
          if (line.startsWith(output)) { inOutput = true; continue }
          else if (inOutput && /^\S/.test(line)) break // autre output
          if (!inOutput) continue
          // ligne de mode : ex "   1920x1080     60.00*+  50.00  "
          const modeMatch = line.match(/^\s+(\d+x\d+)/)
          if (!modeMatch) continue
          const res = modeMatch[1].replace('x', '×')
          if (!resSeen.has(res)) { resSeen.add(res); resolutions.push(res) }
          // taux de rafraîchissement
          const rates = [...line.matchAll(/(\d+\.\d+)/g)].map(m => Math.round(parseFloat(m[1])) + 'Hz')
          rates.forEach(r => { if (!rateSeen.has(r)) { rateSeen.add(r); refreshRates.push(r) } })
        }
        resolve({ resolutions, refreshRates })
      })
    })
  })
}))

/* ── Audio ─────────────────────────────────────────────────────────────────── */
ipcMain.handle('set-audio', async (_, opts) => {
  const cfg = loadConfig(); cfg.audio = opts; saveConfig(cfg)
  return new Promise(resolve => {
    const vol = Math.min(100, Math.max(0, opts.volume || 80))
    exec('which pactl', (err, pactlPath) => {
      if (!err && pactlPath.trim()) {
        exec(`pactl set-sink-volume @DEFAULT_SINK@ ${vol}%`, e => resolve(!e))
      } else {
        exec(`amixer sset Master ${vol}%`, e => resolve(!e))
      }
    })
  })
})

/* ── Réseau ─────────────────────────────────────────────────────────────────── */
ipcMain.handle('get-interfaces', async () => new Promise(resolve => {
  exec("ip -o link show | awk -F': ' '{print $2}' | grep -v lo", (err, out) => {
    if (err || !out.trim()) return resolve([])
    const ifaces = out.trim().split('\n').filter(Boolean)
    Promise.all(ifaces.map(iface => new Promise(res => {
      iface = iface.trim()
      exec(`ip link show ${iface}`, (e1, lo) => {
        const up = /LOWER_UP/.test(lo || '') || (/[<,]UP[,>]/.test(lo || '') && !/NO-CARRIER/.test(lo || ''))
        exec(`ip -4 addr show ${iface}`, (e2, ao) => {
          const m = ao && ao.match(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/)
          const ip = m ? m[1] : null
          const cidr = m ? m[2] : null
          if (!ip) {
            res({ name: iface, ip: null, cidr: null, gateway: null, dns: null, state: up ? 'up' : 'down' })
            return
          }
          // Gateway : table de routage kernel, puis fallback fichiers netplan
          exec(`ip route show table all dev ${iface} 2>/dev/null | grep "^default via"`, (e3, rto) => {
            const gwm = (rto || '').match(/default via (\d+\.\d+\.\d+\.\d+)/)
            let gateway = gwm ? gwm[1] : null
            const finalize = (gateway) => {
              exec(`nmcli dev show ${iface} 2>/dev/null`, (e4, nmo) => {
                const dnsMatches = nmo ? [...nmo.matchAll(/IP4\.DNS\[\d+\]:\s+(\S+)/g)].map(x => x[1]).filter(x => x !== '--') : []
                const dns = dnsMatches.length ? dnsMatches : null
                res({ name: iface, ip, cidr, gateway, dns, state: up ? 'up' : 'down' })
              })
            }
            if (gateway) return finalize(gateway)
            // Fallback : lire les fichiers netplan (gateway4 ou routes[].via)
            exec(`sudo grep -r "via\\|gateway4" /etc/netplan/ 2>/dev/null`, (e5, npo) => {
              const vim = (npo || '').match(/via:\s*["']?(\d+\.\d+\.\d+\.\d+)["']?/)
              const gw4m = (npo || '').match(/gateway4:\s*["']?(\d+\.\d+\.\d+\.\d+)["']?/)
              gateway = (vim || gw4m) ? (vim ? vim[1] : gw4m[1]) : null
              finalize(gateway)
            })
          })
        })
      })
    }))).then(resolve)
  })
}))

ipcMain.handle('get-ip-addresses', async () => {
  const getIP = iface => new Promise(r => {
    exec(`ip -4 addr show ${iface}`, (err, out) => {
      const m = out && out.match(/inet (\d+\.\d+\.\d+\.\d+)/); r(m ? m[1] : null)
    })
  })
  const [wifi, eth] = await Promise.all([getIP('wlan0'), getIP('eth0')])
  return { wifi, eth }
})

ipcMain.handle('wifi-scan', async () => new Promise(resolve => {
  exec('nmcli --fields SSID,SIGNAL,SECURITY --terse dev wifi list 2>/dev/null', (err, out) => {
    if (err || !out) return resolve([])
    const seen = new Set()
    const nets = out.trim().split('\n').map(line => {
      const p = line.split(':')
      if (p.length < 3) return null
      return { ssid: p[0].trim(), signal: p[1].trim() || '0', security: p[2].trim() || '' }
    }).filter(n => { if (!n || !n.ssid || n.ssid === '--') return false; if (seen.has(n.ssid)) return false; seen.add(n.ssid); return true })
    resolve(nets)
  })
}))

ipcMain.handle('wifi-connect', async (_, ssid, pwd) => new Promise(resolve => {
  const s = ssid.replace(/'/g, "'\\''")
  const cmd = pwd ? `nmcli dev wifi connect '${s}' password '${pwd.replace(/'/g, "'\\''")}' ` : `nmcli dev wifi connect '${s}'`
  exec(cmd, err => resolve(!err))
}))

ipcMain.handle('wifi-forget', async (_, ssid) => new Promise(resolve => {
  exec(`nmcli connection delete '${ssid.replace(/'/g, "'\\''")}' `, err => resolve(!err))
}))

ipcMain.handle('wifi-current-ssid', async () => new Promise(resolve => {
  // Récupère le vrai SSID (pas le nom de connexion NM qui peut différer)
  exec('nmcli -t -f ACTIVE,SSID dev wifi 2>/dev/null', (err, out) => {
    if (!err && out) {
      const line = out.trim().split('\n').find(l => l.startsWith('yes:'))
      if (line) return resolve(line.slice(4)) // enlève "yes:"
    }
    // Fallback : iwgetid
    exec('iwgetid -r 2>/dev/null', (e2, o2) => {
      resolve((o2 || '').trim())
    })
  })
}))

ipcMain.handle('wifi-get-known', async () => new Promise(resolve => {
  // Liste toutes les connexions WiFi connues de NetworkManager
  // nmcli -t -f NAME,TYPE connection show  → une ligne par connexion
  exec("nmcli -t -f NAME,TYPE connection show 2>/dev/null", (err, out) => {
    if (err || !out.trim()) return resolve([])
    const names = out.trim().split('\n')
      .map(l => { const p = l.split(':'); return p[1] === '802-11-wireless' ? p[0] : null })
      .filter(Boolean)
    if (!names.length) return resolve([])
    // Pour chaque connexion WiFi, récupérer le SSID et la sécurité
    Promise.all(names.map(name => new Promise(res => {
      exec(`nmcli -t -f 802-11-wireless.ssid,802-11-wireless-security.key-mgmt connection show '${name.replace(/'/g, "'\\''")}' 2>/dev/null`, (e, o) => {
        if (e || !o) return res(null)
        const ssidMatch = o.match(/802-11-wireless\.ssid:(.+)/)
        const secMatch  = o.match(/802-11-wireless-security\.key-mgmt:(.+)/)
        const ssid = ssidMatch ? ssidMatch[1].trim() : name
        const sec  = secMatch  ? secMatch[1].trim()  : ''
        // key-mgmt vide ou '--' = réseau ouvert
        const security = (!sec || sec === '--') ? 'Open' : sec
        res({ ssid, security })
      })
    }))).then(nets => resolve(nets.filter(Boolean)))
  })
}))

ipcMain.handle('wifi-set-priority', async (_, ssids) => new Promise(resolve => {
  // NetworkManager ne gère pas une priorité globale par SSID, mais on peut
  // modifier le champ `connection.autoconnect-priority` de chaque profil.
  // Plus le chiffre est élevé, plus NM préfère ce réseau.
  // On attribue : premier SSID = priorité la plus haute (ssids.length), dernier = 1
  if (!ssids || !ssids.length) return resolve(true)
  const total = ssids.length
  exec("nmcli -t -f NAME,TYPE connection show 2>/dev/null", (err, out) => {
    if (err || !out.trim()) return resolve(false)
    // Map SSID → nom de connexion NM
    const wifiConns = out.trim().split('\n')
      .map(l => { const p = l.split(':'); return p[1] === '802-11-wireless' ? p[0] : null })
      .filter(Boolean)
    Promise.all(ssids.map((ssid, i) => new Promise(res => {
      const priority = total - i  // index 0 → priorité max
      // Chercher la connexion NM correspondant à ce SSID
      const candidates = wifiConns.filter(n => n === ssid || n.toLowerCase().includes(ssid.toLowerCase()))
      const connName = candidates[0]
      if (!connName) return res(false)
      exec(`nmcli connection modify '${connName.replace(/'/g, "'\\''")}' connection.autoconnect-priority ${priority}`, e => res(!e))
    }))).then(results => resolve(results.every(Boolean)))
  })
}))

ipcMain.handle('wifi-disconnect', async () => new Promise(resolve => {
  // Déconnecte l'interface WiFi active (wlan0 en général, sinon détection auto)
  exec("nmcli -t -f DEVICE,TYPE device 2>/dev/null", (err, out) => {
    const wlanDev = (!err && out)
      ? (out.trim().split('\n').map(l => l.split(':')).find(p => p[1] === 'wifi') || [])[0]
      : 'wlan0'
    exec(`nmcli device disconnect '${(wlanDev || 'wlan0').replace(/'/g, "'\\''")}' 2>/dev/null`, e => resolve(!e))
  })
}))

ipcMain.handle('set-static-ip', async (_, opts) => {
  const { iface, dhcp, ip, mask, gw, dns } = opts
  if (!iface) return false
  const cidr = (mask || '255.255.255.0').split('.').reduce((a, o) => a + (parseInt(o) >>> 0).toString(2).split('1').length - 1, 0)
  const dnsVal = dns || '1.1.1.1 1.0.0.1'
  const useNM = await new Promise(r => exec('systemctl is-active NetworkManager', (e, o) => r(!e && o.trim() === 'active')))
  if (!useNM) return false
  return new Promise(resolve => {
    exec('nmcli -t -f NAME,DEVICE connection show --active 2>/dev/null', (e, out) => {
      let conn = null
      if (out) { const line = out.trim().split('\n').find(l => l.endsWith(':' + iface)); if (line) conn = line.split(':')[0] }
      if (!conn) { conn = 'xelauncher-' + iface; exec(`nmcli connection delete '${conn}' 2>/dev/null`, () => { }) }
      const cmd = dhcp
        ? `nmcli connection modify '${conn}' ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""`
        : `nmcli connection modify '${conn}' ipv4.method manual ipv4.addresses '${ip}/${cidr}' ipv4.gateway '${gw || ''}' ipv4.dns '${dnsVal}'`
      exec(cmd, err => {
        if (err) return resolve(false)
        exec(`nmcli connection up '${conn}' ifname ${iface}`, err2 => resolve(!err2))
      })
    })
  })
})

/* ── Bluetooth ──────────────────────────────────────────────────────────────── */
ipcMain.handle('bt-list-paired', async () => new Promise(resolve => {
  exec('bluetoothctl devices Paired 2>/dev/null || bluetoothctl devices 2>/dev/null', (err, out) => {
    if (err || !out.trim()) return resolve([])
    const devs = out.trim().split('\n').map(l => {
      const m = l.match(/Device ([0-9A-Fa-f:]{17}) (.+)/); return m ? { mac: m[1], name: m[2].trim() } : null
    }).filter(Boolean)
    Promise.all(devs.map(d => new Promise(r => {
      exec(`bluetoothctl info ${d.mac} 2>/dev/null`, (e, o) => {
        r({ ...d, connected: /Connected: yes/.test(o || ''), trusted: /Trusted: yes/.test(o || '') })
      })
    }))).then(resolve)
  })
}))

ipcMain.handle('bt-scan', async () => new Promise(resolve => {
  // Lance un scan de 12s via un process bluetoothctl interactif.
  // On collecte tous les événements "Device" en temps réel (nécessaire pour
  // les Wiimotes qui n'apparaissent que pendant la pression du bouton SYNC).
  const discovered = new Map() // mac → name

  const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'ignore'] })
  proc.stdin.write('scan on\n')

  proc.stdout.on('data', chunk => {
    const text = chunk.toString()
    for (const line of text.split('\n')) {
      const m = line.match(/Device ([0-9A-Fa-f:]{17})\s+(.+)/)
      if (m) {
        const mac = m[1], name = m[2].trim()
        if (!discovered.has(mac) || name !== mac) discovered.set(mac, name)
      }
    }
  })

  setTimeout(() => {
    try { proc.stdin.write('scan off\nquit\n'); proc.stdin.end() } catch (e) { }
    proc.kill()

    exec('bluetoothctl devices Paired 2>/dev/null', (e2, paired) => {
      const pairedMacs = new Set(
        (paired || '').trim().split('\n')
          .map(l => { const m = l.match(/Device ([0-9A-Fa-f:]{17})/); return m ? m[1] : null })
          .filter(Boolean)
      )
      const results = []
      for (const [mac, name] of discovered) {
        const isWiimote = /nintendo|rvl-cnt/i.test(name)
        results.push({ mac, name, paired: pairedMacs.has(mac), wiimote: isWiimote })
      }
      resolve(results)
    })
  }, 12000)
}))

ipcMain.handle('bt-pair', async (_, mac) => new Promise(resolve => {
  // Détecter si Wiimote depuis le cache scan ou via bluetoothctl info
  exec(`bluetoothctl info ${mac} 2>/dev/null`, (err, info) => {
    const name = (info || '').match(/Name: (.+)/)?.[1]?.trim() || ''
    const isWiimote = /nintendo|rvl-cnt/i.test(name)

    if (isWiimote) {
      logDebug(`bt-pair Wiimote : ${mac} — flow NoInputNoOutput`)
      // Le flow exact qui fonctionne :
      // 1. Lancer bt-agent NoInputNoOutput en arrière-plan
      // 2. scan on (process interactif)
      // 3. Dès que la Wiimote apparaît → pair immédiatement
      // 4. trust
      // La Wiimote doit être en mode SYNC (clignotement) pendant toute l'opération.

      // S'assurer que hid-wiimote est chargé
      exec('modprobe hid-wiimote 2>/dev/null', () => {

        // Tuer tout agent bluetoothd existant et lancer NoInputNoOutput
        exec('pkill -f "bt-agent" 2>/dev/null', () => {
          const agent = spawn('bt-agent', ['-c', 'NoInputNoOutput'], { stdio: 'ignore', detached: true })
          agent.unref()

          // Laisser l'agent s'enregistrer
          setTimeout(() => {
            // Process bluetoothctl interactif : scan on → attendre la Wiimote → pair → trust
            const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'ignore'] })
            let paired = false
            let scanActive = true

            proc.stdin.write('agent off\nagent NoInputNoOutput\ndefault-agent\nscan on\n')

            proc.stdout.on('data', chunk => {
              const text = chunk.toString()
              logDebug(`bt-pair stdout: ${text.trim()}`)

              // Dès que la Wiimote apparaît dans le scan → pair immédiatement
              if (!paired && text.includes(mac)) {
                paired = true
                scanActive = false
                logDebug(`bt-pair: Wiimote visible, lancement pair ${mac}`)
                proc.stdin.write(`pair ${mac}\n`)
              }

              // Appairage réussi → trust puis terminer
              if (/Pairing successful/i.test(text)) {
                logDebug(`bt-pair: Pairing successful, trust en cours`)
                proc.stdin.write(`trust ${mac}\nquit\n`)
              }

              if (/trust succeeded/i.test(text)) {
                logDebug(`bt-pair: trust OK`)
                try { proc.stdin.end() } catch (e) { }
              }
            })

            proc.on('close', () => {
              exec('pkill -f "bt-agent" 2>/dev/null', () => { })
              // Vérifier le résultat
              exec(`bluetoothctl info ${mac} 2>/dev/null`, (e, o) => {
                const ok = /Paired: yes/i.test(o || '')
                logDebug(`bt-pair résultat: paired=${ok}`)
                resolve(ok)
              })
            })

            // Timeout 20s : si la Wiimote n'apparaît pas, on abandonne
            setTimeout(() => {
              if (!paired) {
                logDebug(`bt-pair timeout: Wiimote non détectée`)
                try { proc.stdin.write('quit\n'); proc.stdin.end() } catch (e) { }
                proc.kill()
              }
            }, 20000)

          }, 500) // délai agent
        })
      })

    } else {
      // Flow standard pour les autres périphériques
      const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'ignore'] })
      let done = false

      proc.stdout.on('data', chunk => {
        const text = chunk.toString()
        if (/Pairing successful|trust succeeded/i.test(text) && !done) {
          done = true
          try { proc.stdin.write('quit\n'); proc.stdin.end() } catch (e) { }
        }
        if (/Pairing successful/i.test(text)) {
          proc.stdin.write(`trust ${mac}\n`)
        }
      })

      proc.on('close', () => {
        exec(`bluetoothctl info ${mac} 2>/dev/null`, (e, o) =>
          resolve(/Paired: yes/i.test(o || '') || /Connected: yes/i.test(o || '')))
      })

      proc.stdin.write(`pair ${mac}\n`)

      setTimeout(() => {
        if (!done) { try { proc.stdin.write('quit\n'); proc.stdin.end() } catch (e) { } proc.kill() }
      }, 15000)
    }
  })
}))

ipcMain.handle('bt-connect', async (_, mac) => new Promise(r => exec(`bluetoothctl connect ${mac}`, (e, o) => r(!e && /Connection successful/i.test(o || '')))))
ipcMain.handle('bt-disconnect', async (_, mac) => new Promise(r => exec(`bluetoothctl disconnect ${mac}`, e => r(!e))))
ipcMain.handle('bt-remove', async (_, mac) => new Promise(r => exec(`bluetoothctl remove ${mac}`, e => r(!e))))

ipcMain.handle('bt-rename', async (_, mac, name) => {
  const cfg = loadConfig(); if (!cfg.btNames) cfg.btNames = {}; cfg.btNames[mac] = name; saveConfig(cfg); return true
})

ipcMain.handle('bt-status', async () => new Promise(resolve => {
  exec('bluetoothctl show 2>/dev/null', (err, out) =>
    resolve({ powered: /Powered: yes/i.test(out || ''), discoverable: /Discoverable: yes/i.test(out || '') }))
}))

ipcMain.handle('bt-power', async (_, on) => new Promise(r => exec(`bluetoothctl power ${on ? 'on' : 'off'}`, e => r(!e))))

/* ── Daemon xe_input — lecteur evdev permanent ───────────────────────────────
 * Lance xe_input.py dès le démarrage du launcher.
 * Reçoit les events JSON sur stdout et les envoie au renderer via IPC.
 * ─────────────────────────────────────────────────────────────────────────── */
const XE_INPUT_SCRIPT = path.join(BASE_DIR, 'scripts', 'xe_input.py')
let xeInputProc = null

function startXeInput() {
  if (xeInputProc) return
  const scriptPath = path.join(BASE_DIR, 'scripts', 'xe_input.py')
  if (!fs.existsSync(scriptPath)) {
    logDebug('xe_input: script absent, ensureDirs() doit être appelé avant')
    return
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
        const ev = JSON.parse(line)
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('xe-input-event', ev)
      } catch(e) {}
    }
  })

  xeInputProc.stderr.on('data', chunk => logDebug('xe_input: ' + chunk.toString().trim()))

  xeInputProc.on('exit', (code) => {
    logDebug(`xe_input: exit ${code}, redémarrage dans 3s`)
    xeInputProc = null
    setTimeout(startXeInput, 3000)
  })
}

function stopXeInput() {
  if (xeInputProc) {
    try { xeInputProc.kill() } catch(e) {}
    xeInputProc = null
  }
}

// Démarrer après que la fenêtre soit prête
app.whenReady().then(() => {
  setTimeout(startXeInput, 2000)
})

app.on('before-quit', stopXeInput)

// IPC pour exposer les events au renderer (preload les forward)
ipcMain.handle('xe-input-status', async () => ({ running: !!xeInputProc }))

/* ── Mapping Jellyfin — persisté sur disque pour xe_jmp_input.py ────────────
 * Le renderer sauvegarde xelauncher_jfmapping (localStorage) ici sous forme
 * de fichier JSON lisible par le script Python pendant la session JMP.
 * ─────────────────────────────────────────────────────────────────────────── */
const JF_MAPPING_FILE = path.join(BASE_DIR, 'jfmapping.json')

ipcMain.handle('save-jf-mapping', async (_, mapping) => {
  try {
    fs.writeFileSync(JF_MAPPING_FILE, JSON.stringify(mapping, null, 2), 'utf8')
    logDebug('jfmapping.json sauvegardé')
    return true
  } catch (e) {
    logDebug('save-jf-mapping error: ' + e.message)
    return false
  }
})

ipcMain.handle('load-jf-mapping', async () => {
  try {
    if (fs.existsSync(JF_MAPPING_FILE))
      return JSON.parse(fs.readFileSync(JF_MAPPING_FILE, 'utf8'))
  } catch (e) { logDebug('load-jf-mapping error: ' + e.message) }
  return {}
})
