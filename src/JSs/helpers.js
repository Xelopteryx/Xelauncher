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
# xe_input.py — Lecteur evdev universel pour XeLauncher Prometheus
import os, sys, json, glob, threading, time
try:
    from evdev import InputDevice, ecodes
except ImportError:
    sys.stderr.write("pip install evdev\\n"); sys.exit(1)

EXCLUDE = {
    'vc4','hdmi','jack','power','pwr','accel','ir ','gyro','motion plus','touchscreen',
    'system control','consumer control','mouse','touchpad','motion sensor','motion sensors',
}

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

def send(device, dev_name, action, raw=None):
    sys.stdout.write(json.dumps({'device':device,'name':dev_name,'action':action,'raw':raw or action})+'\\n')
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
                if action: send(dev_path, dev_name, action, f'KEY_{event.code}')
            elif event.type == ecodes.EV_ABS and event.code in ABS_MAP:
                rng = axis_range.get(event.code, (-32767,32767))
                mn,mx = rng; mid=(mn+mx)/2; span=(mx-mn)/2 or 1
                norm=(event.value-mid)/span; DEAD=0.25
                neg_act,pos_act = ABS_MAP[event.code]
                now=time.monotonic(); last_t=axis_time.get(event.code,0)
                if abs(norm)<DEAD: axis_state[event.code]=None
                elif norm<-DEAD and axis_state.get(event.code)!=neg_act and now-last_t>COOL:
                    axis_state[event.code]=neg_act; axis_time[event.code]=now
                    send(dev_path, dev_name, neg_act, f'ABS_{event.code}_neg')
                elif norm>DEAD and axis_state.get(event.code)!=pos_act and now-last_t>COOL:
                    axis_state[event.code]=pos_act; axis_time[event.code]=now
                    send(dev_path, dev_name, pos_act, f'ABS_{event.code}_pos')
            elif event.type == ecodes.EV_REL and event.code in REL_MAP:
                rel_acc[event.code] = rel_acc.get(event.code,0)+event.value
                neg_act,pos_act = REL_MAP[event.code]
                if rel_acc[event.code]<=-REL_THRESHOLD:
                    send(dev_path, dev_name, neg_act, f'REL_{event.code}_neg'); rel_acc[event.code]=0
                elif rel_acc[event.code]>=REL_THRESHOLD:
                    send(dev_path, dev_name, pos_act, f'REL_{event.code}_pos'); rel_acc[event.code]=0
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
  } catch (e) { logDebug('ensureDirs xe_input error: ' + e.message) }
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
}
