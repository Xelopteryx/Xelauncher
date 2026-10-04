/**
 * helpers.js
 * Chemins, chiffrement, helpers JSON, profils, config, ensureDirs.
 * Chargé en premier par main.js — tout le reste en dépend.
 */

'use strict'

const path   = require('path')
const fs     = require('fs')
const os     = require('os')
const crypto = require('crypto')
const { exec } = require('child_process')

/* ── Chemins ── */
const BASE_DIR        = path.join(os.homedir(), 'xelauncher')
const PROFILES_PATH   = path.join(BASE_DIR, 'profiles.json')
const AVATARS_PATH    = path.join(BASE_DIR, 'src/AVATARs')
const CONFIG_PATH     = path.join(BASE_DIR, 'config.json')
const LOGS_DIR         = path.join(BASE_DIR, 'logs')
const LOG_PATH        = path.join(LOGS_DIR, 'jellyfin_debug.log')
const LAUNCH_NEXT_FILE = '/tmp/xelauncher-launch-next'
const JF_MAPPING_FILE  = path.join(BASE_DIR, 'jfmapping.json')
const SCRIPTS_DIR      = path.join(BASE_DIR, 'scripts')

/* ── Logging ── */
function logDebug(msg) {
  const ts = new Date().toISOString()
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
    fs.appendFileSync(LOG_PATH, `[${ts}] ${msg}\n`)
  } catch (e) {}
  console.log(msg)
}

/* ── Chiffrement des mots de passe ── */
const SECRET_KEY_FILE = path.join(BASE_DIR, '.secret.key')
let _secretKey = null

function getOrCreateSecretKey() {
  if (_secretKey) return _secretKey
  try {
    _secretKey = fs.existsSync(SECRET_KEY_FILE)
      ? fs.readFileSync(SECRET_KEY_FILE, 'utf8')
      : (() => {
          const k = crypto.randomBytes(32).toString('hex')
          fs.mkdirSync(path.dirname(SECRET_KEY_FILE), { recursive: true })
          fs.writeFileSync(SECRET_KEY_FILE, k)
          return k
        })()
  } catch (e) {
    _secretKey = 'xelauncher-static-key-fallback-2024'
  }
  return _secretKey
}

function encrypt(text) {
  if (!text) return ''
  try {
    const key = getOrCreateSecretKey().padEnd(32, '0').slice(0, 32)
    const iv  = crypto.randomBytes(16)
    const c   = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv)
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
    const d   = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), Buffer.from(parts[0], 'hex'))
    d.setAuthTag(Buffer.from(parts[1], 'hex'))
    return d.update(Buffer.from(parts[2], 'hex'), null, 'utf8') + d.final('utf8')
  } catch (e) { return text }
}

/* ── JSON générique ── */
function loadJSON(p, def) {
  try { if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {}
  return def
}

function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(data, null, 2))
}

/* ── Config ── */
function loadConfig()       { return loadJSON(CONFIG_PATH, { controllerType: 'generic' }) }
function saveConfig(data)   { saveJSON(CONFIG_PATH, data) }

/* ── Profils ── */
function loadProfiles() {
  const data = loadJSON(PROFILES_PATH, { server: '', profiles: [] })
  if (data.profiles) data.profiles = data.profiles.map(p => ({ ...p, password: decrypt(p.password || '') }))
  return data
}

function saveProfiles(data) {
  saveJSON(PROFILES_PATH, {
    server:   data.server,
    profiles: data.profiles.map(p => ({ ...p, password: encrypt(p.password || '') }))
  })
}

/* ── Initialisation des dossiers + écriture de xe_input.py ── */
function ensureDirs() {
  [BASE_DIR, AVATARS_PATH, LOGS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }) })

  try {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
    const xeInputPath    = path.join(SCRIPTS_DIR, 'xe_input.py')
    const xeInputContent = `#!/usr/bin/env python3
# xe_input.py v3 — Lecteur evdev universel pour XeLauncher Prometheus
#
# Une ligne JSON par événement sur stdout :
#   { device, name, kind, action, raw, state }
#   kind   : 'keyboard' | 'gamepad' | 'remote'
#   action : action par défaut (table KEY_MAP / ABS_MAP) ou null
#   raw    : identifiant physique stable ('KEY_37', 'ABS_16_neg', ...)
#   state  : 'down' (appui) | 'up' (relâchement)
#
# v3 : TOUTES les touches / tous les axes sont relayés (plus seulement ceux
# de la table par défaut) afin que le mappage puisse cibler n'importe quelle
# touche de clavier, gâchette, clic de stick, axe... C'est le renderer
# (EvdevPoller + InputMapper) qui décide ensuite de ce qui est utilisé.
# La répétition sur appui maintenu est désormais gérée côté renderer.
import sys, json, glob, threading, time, re
try:
    from evdev import InputDevice, ecodes
except ImportError:
    sys.stderr.write("pip install evdev\\n"); sys.exit(1)

EXCLUDE = {
    'vc4','hdmi','jack','power','pwr','accel','gyro','motion plus','touchscreen',
    'system control','consumer control','mouse','touchpad','motion sensor','motion sensors',
}

# Actions par défaut — utilisées uniquement pour un appareil sans mappage.
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
    15:'menu',    # KEY_TAB
    42:'action',  # KEY_LEFTSHIFT
}

ABS_MAP = {
    0:('left','right'), 1:('up','down'), 2:('left','right'), 5:('up','down'),
    16:('left','right'), 17:('up','down'), 18:('left','right'), 19:('up','down'),
}
REL_MAP = {0:('left','right'), 1:('up','down'), 8:('left','right'), 11:('up','down')}
REL_THRESHOLD = 8

HAT_CODES = (16, 17, 18, 19)
STICK_ON, STICK_OFF = 0.45, 0.25   # hystérésis des sticks / croix
TRIG_ON,  TRIG_OFF  = 0.50, 0.30   # hystérésis des gâchettes analogiques
AXIS_GRACE = 1.5                   # états d'axes initiaux absorbés (secondes)

_out_lock = threading.Lock()
_skipped = set()
_skipped_lock = threading.Lock()


def send(device, dev_name, kind, action, raw, state='down'):
    msg = json.dumps({'device': device, 'name': dev_name, 'kind': kind,
                      'action': action, 'raw': raw, 'state': state})
    with _out_lock:
        sys.stdout.write(msg + '\\n')
        sys.stdout.flush()


def should_exclude(name):
    nl = name.lower()
    if any(x in nl for x in EXCLUDE): return True
    # "IR" (caméra infrarouge Wiimote) et "IMU" (capteur de mouvement) :
    # exclus comme MOTS ENTIERS uniquement ("Wireless Controller" contient "ir").
    return re.search(r'(^|[^a-z])(ir|imu)($|[^a-z])', nl) is not None


def classify(caps):
    keys = set(caps.get(ecodes.EV_KEY, []))
    absn = set(c for c, _ in caps.get(ecodes.EV_ABS, []))
    if sum(1 for c in range(16, 26) if c in keys) >= 8:      # rangée Q..P
        return 'keyboard'
    if any(0x120 <= c <= 0x13f for c in keys) or (0 in absn and 1 in absn):
        return 'gamepad'
    return 'remote'


def setup_axes(dev, caps):
    """Détecte pour chaque axe s'il s'agit d'un stick/croix (centré) ou d'une
    gâchette analogique (repos à une extrémité de la plage)."""
    axes = {}
    for code, info in caps.get(ecodes.EV_ABS, []):
        if code >= 0x28:            # ABS_MISC, multitouch... : ignorés
            continue
        mn, mx = info.min, info.max
        span = mx - mn
        if span <= 0:
            continue
        mode, rest = 'stick', None
        if code not in HAT_CODES and mn >= 0 and span > 1:
            try: val = dev.absinfo(code).value
            except Exception: val = info.value
            frac = (val - mn) / float(span)
            if frac <= 0.12:   mode, rest = 'trigger', 'min'
            elif frac >= 0.88: mode, rest = 'trigger', 'max'
        axes[code] = {'mn': mn, 'mx': mx, 'mode': mode, 'rest': rest,
                      'state': None, 'silent': False}
    return axes


def watch(dev_path, stop_event):
    try:
        dev = InputDevice(dev_path)
        dev_name = dev.name
        if should_exclude(dev_name):
            with _skipped_lock: _skipped.add(dev_path)
            print('[xe_input] SKIP (excluded) %s' % dev_name, file=sys.stderr, flush=True)
            return
        caps = dev.capabilities()
        kind = classify(caps)
        axes = setup_axes(dev, caps)
        print('[xe_input] WATCH %s @ %s (%s)' % (dev_name, dev_path, kind), file=sys.stderr, flush=True)
        rel_acc = {}
        t_open = time.monotonic()

        def emit(action, raw, state='down'):
            send(dev_path, dev_name, kind, action, raw, state)

        def axis_down(code, ax, direction, quiet):
            ax['state'] = direction
            ax['silent'] = quiet
            if quiet:
                return
            action = None
            if ax['mode'] == 'stick' and code in ABS_MAP:
                neg_act, pos_act = ABS_MAP[code]
                action = neg_act if direction == 'neg' else pos_act
            emit(action, 'ABS_%d_%s' % (code, direction))

        def axis_up(code, ax):
            direction = ax['state']
            if direction and not ax['silent']:
                emit(None, 'ABS_%d_%s' % (code, direction), 'up')
            ax['state'] = None
            ax['silent'] = False

        for event in dev.read_loop():
            if stop_event.is_set(): break
            if event.type == ecodes.EV_KEY:
                if event.value == 1:
                    emit(KEY_MAP.get(event.code), 'KEY_%d' % event.code)
                elif event.value == 0:
                    emit(None, 'KEY_%d' % event.code, 'up')
            elif event.type == ecodes.EV_ABS:
                ax = axes.get(event.code)
                if ax is None:
                    continue
                code = event.code
                quiet = (time.monotonic() - t_open) < AXIS_GRACE
                span = float(ax['mx'] - ax['mn'])
                if ax['mode'] == 'trigger':
                    frac = (event.value - ax['mn']) / span
                    pressed = frac if ax['rest'] == 'min' else 1 - frac
                    direction = 'pos' if ax['rest'] == 'min' else 'neg'
                    if ax['state'] is None and pressed >= TRIG_ON:
                        axis_down(code, ax, direction, quiet)
                    elif ax['state'] is not None and pressed <= TRIG_OFF:
                        axis_up(code, ax)
                else:
                    norm = (event.value - (ax['mn'] + ax['mx']) / 2.0) / (span / 2.0)
                    cur = ax['state']
                    new = 'neg' if norm < 0 else 'pos'
                    if cur is None:
                        if abs(norm) >= STICK_ON:
                            axis_down(code, ax, new, quiet)
                    elif abs(norm) <= STICK_OFF:
                        axis_up(code, ax)
                    elif abs(norm) >= STICK_ON and new != cur:
                        axis_up(code, ax)
                        axis_down(code, ax, new, quiet)
            elif event.type == ecodes.EV_REL and event.code in REL_MAP:
                rel_acc[event.code] = rel_acc.get(event.code, 0) + event.value
                neg_act, pos_act = REL_MAP[event.code]
                if rel_acc[event.code] <= -REL_THRESHOLD:
                    emit(neg_act, 'REL_%d_neg' % event.code); rel_acc[event.code] = 0
                elif rel_acc[event.code] >= REL_THRESHOLD:
                    emit(pos_act, 'REL_%d_pos' % event.code); rel_acc[event.code] = 0
    except Exception as e:
        print('[xe_input] Error %s: %s' % (dev_path, e), file=sys.stderr, flush=True)


def main():
    threads = {}; stop_events = {}
    while True:
        current = set(glob.glob('/dev/input/event*'))
        with _skipped_lock:
            _skipped.intersection_update(current)
            skipped = set(_skipped)
        for dev_path in current:
            if dev_path in skipped:
                continue
            if dev_path not in threads or not threads[dev_path].is_alive():
                stop_ev = threading.Event()
                t = threading.Thread(target=watch, args=(dev_path, stop_ev), daemon=True)
                t.start(); threads[dev_path] = t; stop_events[dev_path] = stop_ev
        for dev_path in list(threads.keys()):
            if dev_path not in current:
                stop_events[dev_path].set(); del threads[dev_path]; del stop_events[dev_path]
        time.sleep(3)


if __name__ == '__main__': main()
`
    fs.writeFileSync(xeInputPath, xeInputContent, { mode: 0o755 })
  } catch (e) { logDebug('ensureDirs xe_input error: ' + e.message) }
}

/**
 * ensureAudioRouting — fait suivre ALSA sur PulseAudio à l'échelle du
 * système, pour que TOUTE application ALSA "default" (RetroArch,
 * EmulationStation, etc.) suive la même sortie que celle choisie dans
 * Réglages > Audio, exactement comme Jellyfin le fait déjà.
 *
 * ── Historique / pourquoi cette fonction ne fait plus que nettoyer ──
 * Deux tentatives précédentes se sont révélées être des régressions :
 *   1. "options snd slots=..." (ordre forcé des cartes ALSA) pouvait
 *      carrément empêcher un dongle USB générique d'être détecté sur
 *      les Pi/noyaux récents (HDMI via vc4_hdmi, pas snd_bcm2835).
 *   2. La redirection système "/etc/asound.conf" (ALSA "default" ->
 *      PulseAudio) fait passer TOUT ce qui parle à ALSA "default" par
 *      ce pont — y compris QtWebEngine/Chromium dans Jellyfin Desktop,
 *      qui se retrouvait à ramer ~1 minute au lancement le temps que la
 *      négociation de connexion aboutisse.
 * Aucune des deux n'était en réalité nécessaire : le vrai fix RetroArch
 * (audio_driver="pulse" dans retroarch.cfg, voir ipc-retropie.js) parle
 * DIRECTEMENT à PulseAudio via sa propre librairie, sans jamais passer
 * par ALSA ni par cette redirection — les deux mécanismes sont
 * complètement indépendants, inutile de les avoir mélangés.
 * Cette fonction ne fait donc plus qu'annuler, automatiquement et sans
 * intervention SSH, tout ce qu'une version précédente aurait écrit.
 */
function ensureAudioRouting() {
  /* ── Nettoyage 1 : ordre forcé des cartes ALSA (alsa-base.conf) ── */
  const ALSA_BASE = '/etc/modprobe.d/alsa-base.conf'
  const MARKER_ORDER = '# xelauncher-usb-audio-priority'
  const KNOWN_ORDER_LINES = new Set([
    MARKER_ORDER,
    'options snd_usb_audio index=0',
    'options snd_bcm2835 index=1',
    'options snd slots=snd-usb-audio,snd-bcm2835',
  ])
  try {
    if (fs.existsSync(ALSA_BASE)) {
      const cur = fs.readFileSync(ALSA_BASE, 'utf8')
      if (cur.includes(MARKER_ORDER)) {
        const cleaned = cur.split('\n').filter(line => !KNOWN_ORDER_LINES.has(line.trim())).join('\n')
        const tmp = path.join(os.tmpdir(), 'xe_alsa_base_cleaned.conf')
        fs.writeFileSync(tmp, cleaned)
        exec(`sudo cp "${tmp}" ${ALSA_BASE}`, (e) => {
          logDebug(e
            ? 'ensureAudioRouting: échec nettoyage ' + ALSA_BASE + ': ' + e.message
            : 'ensureAudioRouting: bloc "priorité USB" retiré de ' + ALSA_BASE)
        })
      }
    }
  } catch (e) {
    logDebug('ensureAudioRouting: erreur ' + ALSA_BASE + ': ' + e.message)
  }

  /* ── Nettoyage 2 : redirection ALSA "default" -> PulseAudio (asound.conf) ──
     Suppression du bloc exact écrit par une version précédente ; on ne
     touche à rien d'autre dans le fichier (pas de filtrage ligne par
     ligne générique ici, "}" seul serait trop dangereux à faire sauter
     si le fichier contient d'autres définitions ALSA). */
  const ASOUND_CONF = '/etc/asound.conf'
  const MARKER_PULSE = '# xelauncher-pulse-redirect'
  const KNOWN_PULSE_BLOCK = `${MARKER_PULSE}\npcm.!default {\n  type pulse\n}\nctl.!default {\n  type pulse\n}\n`
  try {
    if (fs.existsSync(ASOUND_CONF)) {
      const cur = fs.readFileSync(ASOUND_CONF, 'utf8')
      if (cur.includes(MARKER_PULSE)) {
        const cleaned = cur.split(KNOWN_PULSE_BLOCK).join('')
        const tmp = path.join(os.tmpdir(), 'xe_asound_cleaned.conf')
        fs.writeFileSync(tmp, cleaned)
        exec(`sudo cp "${tmp}" ${ASOUND_CONF}`, (e) => {
          logDebug(e
            ? 'ensureAudioRouting: échec nettoyage ' + ASOUND_CONF + ': ' + e.message
            : 'ensureAudioRouting: redirection ALSA->Pulse retirée de ' + ASOUND_CONF)
        })
      }
    }
  } catch (e) {
    logDebug('ensureAudioRouting: erreur ' + ASOUND_CONF + ': ' + e.message)
  }
}

module.exports = {
  BASE_DIR, PROFILES_PATH, AVATARS_PATH, CONFIG_PATH,
  LOG_PATH, LAUNCH_NEXT_FILE, JF_MAPPING_FILE, SCRIPTS_DIR,
  logDebug, getOrCreateSecretKey,
  encrypt, decrypt,
  loadJSON, saveJSON,
  loadConfig, saveConfig,
  loadProfiles, saveProfiles,
  ensureDirs,
  ensureAudioRouting,
}
