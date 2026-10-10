/**
 * ipc-turtlefin.js
 * Turtlefin (client Jellyfin natif) comme lecteur multimédia du menu, au lieu de Jellyfin Desktop.
 *
 * Choisi à l'installation (install.sh --turtlefin, ou la question posée) : config.json "player".
 * Turtlefin gère lui-même ses comptes (écran « Qui regarde ? ») : pas de page profiles.html, pas
 * d'injection de session. Il se pilote entièrement au clavier : xe_tf_input.py relaie les manettes et
 * télécommandes en touches clavier, avec le même système de normalisation que le menu (xe_input.py +
 * mappages des appareils, recopiés dans inputmaps.json).
 */

'use strict'

const { ipcMain } = require('electron')
const path        = require('path')
const fs          = require('fs')

const { BASE_DIR, SCRIPTS_DIR, INPUT_MAPS_FILE, logDebug, loadConfig } = require('./helpers')
const { handoffToExternal } = require('./main-window')

function isTurtlefin() {
  return loadConfig().player === 'turtlefin'
}

/* -- Mappages des appareils recopiés sur disque (le menu les garde dans localStorage) -- */
ipcMain.handle('save-input-maps', async (_, maps) => {
  try {
    fs.mkdirSync(path.dirname(INPUT_MAPS_FILE), { recursive: true })
    fs.writeFileSync(INPUT_MAPS_FILE, JSON.stringify(maps || {}, null, 2), 'utf8')
    return true
  } catch (e) {
    logDebug('save-input-maps error: ' + e.message)
    return false
  }
})

/* -- Lancement : Electron se ferme, xelauncher.sh exécute le wrapper puis relance le menu -- */
function launchTurtlefin() {
  const TF_WRAPPER = path.join(SCRIPTS_DIR, 'turtlefin_wrapper.sh')
  const TF_INPUT   = path.join(SCRIPTS_DIR, 'xe_tf_input.py')
  const TF_LOG     = path.join(BASE_DIR, 'logs', 'turtlefin_wrapper.log')
  try {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true })
    fs.mkdirSync(path.dirname(TF_LOG), { recursive: true })
    fs.writeFileSync(TF_INPUT, buildTfInputScript(), { mode: 0o755 })
    fs.writeFileSync(TF_WRAPPER, buildWrapper(TF_INPUT, TF_LOG), { mode: 0o755 })
  } catch (e) {
    logDebug('launchTurtlefin: écriture des scripts impossible: ' + e.message)
    return false
  }
  logDebug('=== LANCEMENT TURTLEFIN ===')
  handoffToExternal(`bash "${TF_WRAPPER}"`)
  return true
}

function buildWrapper(tfInput, tfLog) {
  return `#!/bin/bash
export DISPLAY=:0
export XAUTHORITY="\$HOME/.Xauthority"
export XDG_RUNTIME_DIR="/run/user/\$(id -u)"

exec > >(tee -a "${tfLog}") 2>&1
echo ""
echo "===== \$(date '+%Y-%m-%d %H:%M:%S') turtlefin_wrapper démarré (PID \$\$) ====="

# X11 joignable (max 10 s)
for i in \$(seq 1 20); do
    DISPLAY=:0 xdpyinfo >/dev/null 2>&1 && break
    sleep 0.5
done

# GPU libéré par Electron (max 5 s) : comme pour Jellyfin, la vidéo ne s'initialise pas tant
# qu'un autre processus tient /dev/dri.
if command -v fuser >/dev/null 2>&1; then
    for i in \$(seq 1 10); do
        BUSY=0
        for dev in /dev/dri/card* /dev/dri/renderD*; do
            [ -e "\$dev" ] && fuser "\$dev" >/dev/null 2>&1 && BUSY=1
        done
        [ "\$BUSY" -eq 0 ] && break
        sleep 0.5
    done
fi

# Manettes et télécommandes -> touches clavier pour Turtlefin
INPUT_PID=""
if command -v python3 >/dev/null && [ -f "${tfInput}" ]; then
    python3 "${tfInput}" "${INPUT_MAPS_FILE}" &
    INPUT_PID=\$!
    echo "[tf_wrapper] xe_tf_input PID=\$INPUT_PID"
fi

if command -v turtlefin >/dev/null 2>&1; then
    turtlefin --tv
    echo "[tf_wrapper] Turtlefin terminé (exit=\$?)"
else
    echo "[tf_wrapper] turtlefin introuvable (réinstaller XeLauncher avec --turtlefin)"
fi

# Le relais rend les manettes à X (fin de l'exclusivité) en s'arrêtant.
if [ -n "\$INPUT_PID" ]; then
    kill "\$INPUT_PID" 2>/dev/null
    wait "\$INPUT_PID" 2>/dev/null
fi
`
}

/* -- Script Python xe_tf_input.py -- */
function buildTfInputScript() {
  return String.raw`#!/usr/bin/env python3
# xe_tf_input.py -- manettes et télécommandes -> touches clavier pour Turtlefin.
#
# Réutilise la normalisation du menu XeLauncher : xe_input.py lit tous les appareils (identifiants
# stables KEY_x / ABS_x_neg..., sticks et gâchettes avec hystérésis, action par défaut), ici lancé
# avec XE_INPUT_GRAB=1 pour que X ne reçoive pas en plus les touches des manettes et télécommandes.
# Chaque appui est résolu comme dans le menu (InputMapper) : mappage personnalisé de l'appareil
# (inputmaps.json) STRICT, sinon l'action par défaut ; puis envoyé à Turtlefin par xdotool.
# Les vrais claviers sont ignorés : X les donne déjà directement à Turtlefin.
import sys, os, json, time, threading, subprocess, signal

SCRIPTS   = os.path.dirname(os.path.abspath(__file__))
MAPS_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/xelauncher/inputmaps.json')
XE_INPUT  = os.path.join(SCRIPTS, 'xe_input.py')
ENV       = dict(os.environ, DISPLAY=os.environ.get('DISPLAY', ':0'))

# Action XeLauncher -> touche de Turtlefin (flèches, Entrée, Échap = retour, Espace = pause).
KEYS = {
    'up': 'Up', 'down': 'Down', 'left': 'Left', 'right': 'Right',
    'confirm': 'Return', 'back': 'Escape', 'menu': 'space',
}
REPEAT = ('up', 'down', 'left', 'right')
REPEAT_DELAY, REPEAT_INTERVAL, REPEAT_MAX = 0.5, 0.09, 8.0

_maps = [{}, 0.0]

def load_maps():
    try:
        mtime = os.path.getmtime(MAPS_FILE)
        if mtime != _maps[1]:
            with open(MAPS_FILE) as f:
                data = json.load(f)
            _maps[0] = data if isinstance(data, dict) else {}
            _maps[1] = mtime
    except Exception:
        pass
    return _maps[0]

def resolve(name, raw, default_action):
    """Même règle que InputMapper.resolveKey : mappage personnalisé strict, sinon défaut."""
    m = load_maps().get(name)
    if isinstance(m, dict):
        real = {}
        for k, v in m.items():
            if k.startswith('_'):
                continue
            lst = v if isinstance(v, list) else [v]
            lst = [x for x in lst if isinstance(x, str) and x]
            if lst:
                real[k] = lst
        if real:
            for action, lst in real.items():
                if raw in lst:
                    return action
            return None
    return default_action

def log(msg):
    print('[xe_tf_input] ' + msg, flush=True)

# -- Fenêtre de Turtlefin : gardée au premier plan pour recevoir les touches --
_win = {'ids': [], 't': 0.0}

def turtlefin_windows():
    now = time.monotonic()
    if now - _win['t'] > 3 or not _win['ids']:
        ids = []
        for args in (['--class', 'turtlefin'], ['--name', '^Turtlefin$']):
            try:
                out = subprocess.run(['xdotool', 'search'] + args, env=ENV, capture_output=True,
                                     text=True, timeout=1).stdout.split()
                ids += [w for w in out if w.isdigit() and w not in ids]
            except Exception:
                pass
        _win['ids'], _win['t'] = ids, now
    return _win['ids']

def send_key(k):
    try:
        wins = turtlefin_windows()
        if wins:
            active = subprocess.run(['xdotool', 'getactivewindow'], env=ENV, capture_output=True,
                                    text=True, timeout=0.5).stdout.strip()
            if active not in wins:
                subprocess.run(['xdotool', 'windowactivate', '--sync', wins[-1]], env=ENV,
                               capture_output=True, timeout=1)
        subprocess.run(['xdotool', 'key', '--clearmodifiers', k], env=ENV, capture_output=True, timeout=1)
    except Exception as e:
        log('xdotool : %s' % e)

# -- Appui maintenu sur une direction : répétition --
_repeats = {}
_rep_lock = threading.Lock()

def stop_repeat(rid):
    with _rep_lock:
        ev = _repeats.pop(rid, None)
    if ev:
        ev.set()

def start_repeat(rid, k):
    stop_repeat(rid)
    ev = threading.Event()
    with _rep_lock:
        _repeats[rid] = ev
    def run():
        if ev.wait(REPEAT_DELAY):
            return
        t0 = time.monotonic()
        while not ev.wait(REPEAT_INTERVAL):
            if time.monotonic() - t0 > REPEAT_MAX:
                return
            send_key(k)
    threading.Thread(target=run, daemon=True).start()

def handle(ev):
    if ev.get('kind') == 'keyboard':
        return
    name = ev.get('name') or ev.get('device') or ''
    raw = ev.get('raw') or ''
    rid = (ev.get('device'), raw)
    if ev.get('state') == 'up':
        stop_repeat(rid)
        return
    action = resolve(name, raw, ev.get('action'))
    k = KEYS.get(action)
    if not k:
        return
    send_key(k)
    if action in REPEAT:
        start_repeat(rid, k)

_proc = [None]

def stop(*_):
    p = _proc[0]
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=2)
        except Exception:
            p.kill()
    sys.exit(0)

def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if not os.path.exists(XE_INPUT):
        log('xe_input.py absent : ' + XE_INPUT)
        return
    while True:
        p = subprocess.Popen(['python3', XE_INPUT], env=dict(ENV, XE_INPUT_GRAB='1'),
                             stdout=subprocess.PIPE, text=True, bufsize=1)
        _proc[0] = p
        log('xe_input.py démarré (PID %d)' % p.pid)
        for line in p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                handle(json.loads(line))
            except Exception as e:
                log('événement ignoré : %s' % e)
        log('xe_input.py arrêté, relance dans 2 s')
        time.sleep(2)

if __name__ == '__main__':
    main()
`
}

module.exports = { isTurtlefin, launchTurtlefin }
