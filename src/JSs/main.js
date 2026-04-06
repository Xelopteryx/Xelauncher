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
  const EVDEV_SCRIPT = path.join(SCRIPTS_DIR, 'xe_evdev_capture.py')

  // ── Script evdev (inchangé) ───────────────────────────────────────────────
  const evdevContent = `#!/usr/bin/env python3
# xe_evdev_capture.py - Capture directe des événements manettes via evdev
import os, sys, json, time, subprocess, threading, glob
from evdev import InputDevice, categorize, ecodes

MAPS_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/xelauncher/inputmaps.json')
RUNNING = True

ACTION_MAP = {
    'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
    'confirm': 'Return', 'back': 'Escape', 'menu': 'Return', 'action': 't'
}

EVDEV_TO_XE = {
    0x130: 'Enter', 0x131: 'Escape', 0x132: 'Square', 0x133: 'Triangle',
    0x136: 'L1', 0x137: 'R1', 0x138: 'L2', 0x139: 'R2',
    0x13a: 'Select', 0x13b: 'Start', 0x13c: 'L3', 0x13d: 'R3',
}

AXES = {
    'ABS_X': ('ArrowLeft', 'ArrowRight'),
    'ABS_Y': ('ArrowUp', 'ArrowDown'),
    'ABS_RX': ('ArrowLeft', 'ArrowRight'),
    'ABS_RY': ('ArrowUp', 'ArrowDown'),
}

def load_maps():
    try:
        with open(MAPS_FILE) as f:
            return json.load(f)
    except:
        return {}

def resolve_key(device_name, raw, maps):
    m = maps.get(device_name)
    if not m:
        return ACTION_MAP.get(raw)
    for action, mapped in m.items():
        if mapped == raw:
            return ACTION_MAP.get(action)
    return None

def send_key(key):
    if not key:
        return
    try:
        subprocess.run(['xdotool', 'key', '--clearmodifiers', key],
                       timeout=0.1, capture_output=True)
    except:
        pass

def watch_device(dev_path, maps_ref):
    try:
        dev = InputDevice(dev_path)
        print(f'[evdev] Monitoring: {dev.name}', flush=True)
        axis_state = {}
        
        for event in dev.read_loop():
            if not RUNNING:
                break
            
            maps = maps_ref[0]
            
            if event.type == ecodes.EV_KEY:
                if event.value == 1:
                    raw = EVDEV_TO_XE.get(event.code)
                    if raw:
                        key = resolve_key(dev.name, raw, maps)
                        if key:
                            send_key(key)
            elif event.type == ecodes.EV_ABS:
                abs_event = categorize(event)
                axis_name = ecodes.ABS[event.code]
                if axis_name in AXES:
                    deadzone = 20000
                    if abs(event.value) < deadzone:
                        axis_state[axis_name] = None
                        continue
                    
                    direction = 0 if event.value < 0 else 1
                    new_key = AXES[axis_name][direction]
                    
                    if axis_state.get(axis_name) != new_key:
                        axis_state[axis_name] = new_key
                        key = resolve_key(dev.name, new_key, maps)
                        if key:
                            send_key(key)
    except Exception as e:
        print(f'[evdev] Error {dev_path}: {e}', flush=True)

def main():
    maps_ref = [load_maps()]
    threads = {}
    
    while RUNNING:
        maps_ref[0] = load_maps()
        for dev_path in glob.glob('/dev/input/event*'):
            try:
                dev = InputDevice(dev_path)
                if any(x in dev.name.lower() for x in ['joystick', 'gamepad', 'controller', 'playstation', 'xbox']):
                    if dev_path not in threads or not threads[dev_path].is_alive():
                        t = threading.Thread(target=watch_device, args=(dev_path, maps_ref), daemon=True)
                        t.start()
                        threads[dev_path] = t
            except:
                pass
        time.sleep(5)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        RUNNING = False
`

  try {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
    fs.writeFileSync(EVDEV_SCRIPT, evdevContent, { mode: 0o755 })
    logDebug('Script evdev écrit')
  } catch (e) { logDebug(`Erreur écriture evdev: ${e.message}`) }

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

  const wrapperContent = `#!/bin/bash
EVDEV_SCRIPT="${EVDEV_SCRIPT}"
MAPS_FILE="${MAPS_FILE}"
JMP_URL='${jmpUrl}'
REMAP_PID=""
if command -v python3 >/dev/null && [ -f "$EVDEV_SCRIPT" ]; then
  python3 "$EVDEV_SCRIPT" "$MAPS_FILE" &
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
# xe_jmp_input.py -- Remapping joystick -> clavier pour JMP
# Lit UNIQUEMENT /dev/input/js* — jamais les claviers ni l'alimentation.
# Pas de grab exclusif : le clavier et la telecommande restent pleinement fonctionnels.
import sys, os, json, struct, threading, subprocess, time, glob, fcntl, ctypes

MAPS_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/xelauncher/inputmaps.json')

ACTION_TO_KEY = {
    'up':      'Up',
    'down':    'Down',
    'left':    'Left',
    'right':   'Right',
    'confirm': 'Return',
    'back':    'Escape',
    'menu':    'Return',
    'action':  't',
}

# Boutons joystick interface js* (numero 0-based) -> nom XeInput
JS_BUTTONS = {
    0: 'Enter',    # Croix/A
    1: 'Escape',   # Rond/B
    2: 'Square',   # Carre/X
    3: 'Triangle', # Triangle/Y
    4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2',
    8: 'Select', 9: 'Start',
}

JS_FORMAT        = 'IhBB'
JS_SIZE          = struct.calcsize(JS_FORMAT)
JS_EVENT_BUTTON  = 0x01
JS_EVENT_AXIS    = 0x02
JS_EVENT_INIT    = 0x80
DEAD_ZONE        = 0.5

def load_maps():
    try:
        with open(MAPS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def get_js_name(fileno):
    JSIOCGNAME = 0x81004a13
    buf = ctypes.create_string_buffer(256)
    try:
        fcntl.ioctl(fileno, JSIOCGNAME, buf)
        return buf.value.decode('utf-8', errors='replace').strip()
    except Exception:
        return ''

def resolve_key(device_name, raw_key, maps):
    m = maps.get(device_name)
    if not m:
        return ACTION_TO_KEY.get(raw_key)
    for action, mapped in m.items():
        if mapped == raw_key:
            return ACTION_TO_KEY.get(action)
    return None

def send_key(key):
    if not key:
        return
    try:
        subprocess.run(['xdotool', 'key', '--clearmodifiers', key],
                       timeout=0.15, capture_output=True)
    except Exception:
        pass

def monitor_js(dev_path, maps_ref):
    try:
        fd = open(dev_path, 'rb')
        name = get_js_name(fd.fileno()) or dev_path
        print('[xe_jmp_input] Joystick: ' + name + ' (' + dev_path + ')', flush=True)
        axis_state = {}
        while True:
            data = fd.read(JS_SIZE)
            if len(data) < JS_SIZE:
                break
            t_ms, value, ev_type, number = struct.unpack(JS_FORMAT, data)
            ev_type = ev_type & ~JS_EVENT_INIT
            maps = maps_ref[0]
            if ev_type == JS_EVENT_BUTTON and value == 1:
                raw = JS_BUTTONS.get(number)
                if raw:
                    send_key(resolve_key(name, raw, maps))
            elif ev_type == JS_EVENT_AXIS:
                norm = value / 32767.0
                prev = axis_state.get(number, 0.0)
                axis_state[number] = norm
                if number in (0, 6):
                    if norm < -DEAD_ZONE and prev >= -DEAD_ZONE:
                        send_key(resolve_key(name, 'ArrowLeft', maps))
                    elif norm > DEAD_ZONE and prev <= DEAD_ZONE:
                        send_key(resolve_key(name, 'ArrowRight', maps))
                elif number in (1, 7):
                    if norm < -DEAD_ZONE and prev >= -DEAD_ZONE:
                        send_key(resolve_key(name, 'ArrowUp', maps))
                    elif norm > DEAD_ZONE and prev <= DEAD_ZONE:
                        send_key(resolve_key(name, 'ArrowDown', maps))
    except Exception as e:
        print('[xe_jmp_input] Erreur ' + dev_path + ': ' + str(e), flush=True)
    finally:
        try:
            fd.close()
        except Exception:
            pass

def main():
    maps_ref = [load_maps()]
    threads = {}
    while True:
        maps_ref[0] = load_maps()
        for dev in glob.glob('/dev/input/js*'):
            if dev not in threads or not threads[dev].is_alive():
                t = threading.Thread(target=monitor_js, args=(dev, maps_ref), daemon=True)
                t.start()
                threads[dev] = t
        time.sleep(2)

if __name__ == '__main__':
    main()
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
          res({ name: iface, ip: m ? m[1] : null, cidr: m ? m[2] : null, state: up ? 'up' : 'down' })
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
  exec('nmcli -t -f NAME,TYPE connection show --active 2>/dev/null', (err, out) => {
    if (err || !out) return resolve('')
    const line = out.trim().split('\n').find(l => l.includes('wifi') || l.includes('802-11'))
    resolve(line ? line.split(':')[0] : '')
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
  exec('bluetoothctl --timeout 8 scan on 2>/dev/null', () => {
    exec('bluetoothctl devices 2>/dev/null', (err, out) => {
      if (err || !out.trim()) return resolve([])
      exec('bluetoothctl devices Paired 2>/dev/null', (e2, paired) => {
        const pairedMacs = new Set((paired || '').trim().split('\n').map(l => { const m = l.match(/Device ([0-9A-Fa-f:]{17})/); return m ? m[1] : null }).filter(Boolean))
        resolve(out.trim().split('\n').map(l => { const m = l.match(/Device ([0-9A-Fa-f:]{17}) (.+)/); return m ? { mac: m[1], name: m[2].trim(), paired: pairedMacs.has(m[1]) } : null }).filter(Boolean))
      })
    })
  })
}))

ipcMain.handle('bt-pair', async (_, mac) => new Promise(resolve => {
  exec(`echo -e "pair ${mac}\ntrust ${mac}\nconnect ${mac}\nquit" | bluetoothctl 2>/dev/null`, (err, out) =>
    resolve(!err && /Pairing successful|Connected: yes|trust succeeded/i.test(out || '')))
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
