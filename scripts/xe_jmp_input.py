#!/usr/bin/env python3
# xe_jmp_input.py -- Remapping evdev -> xdotool pour Jellyfin Desktop
import sys, os, json, threading, time, glob, subprocess
try:
    from evdev import InputDevice, ecodes
except ImportError:
    sys.stderr.write("pip install evdev\n"); sys.exit(1)

JF_MAPPING_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser('~/xelauncher/jfmapping.json')

EXCLUDE = {
    'vc4','hdmi','jack','power','pwr','accel','ir ','gyro',
    'motion plus','touchscreen','system control','consumer control',
    'mouse','touchpad','motion sensor','motion sensors',
}
UNMAPPABLE = ['ir','sensor','motion','accelero','gyro','touchpad','touch pad','nunchuk extension']

# jf_id -> touche xdotool
JF_XDO = {
    'jf_up':'Up','jf_down':'Down','jf_left':'Left','jf_right':'Right',
    'jf_ok':'Return','jf_back':'Escape','jf_menu':'m','jf_prev':'j','jf_next':'l',
}

# Fallback: code evdev -> jf_id (pour appareils sans mapping custom)
KEY_TO_JF = {
    103:'jf_up', 108:'jf_down', 105:'jf_left', 106:'jf_right',
    28:'jf_ok', 57:'jf_ok',
    1:'jf_back', 14:'jf_back',
    0x130:'jf_ok', 0x131:'jf_back',
    0x13b:'jf_menu', 0x13c:'jf_menu',
    0x101:'jf_ok', 0x102:'jf_back', 0x197:'jf_menu',
    0x8b:'jf_menu', 0x66:'jf_ok', 0x9e:'jf_back', 0xa4:'jf_ok',
    0x160:'jf_ok', 0x166:'jf_menu', 0xe3:'jf_back',
    0x110:'jf_ok', 0x111:'jf_back',
}
ABS_TO_JF = {
    0:('jf_left','jf_right'), 1:('jf_up','jf_down'),
    2:('jf_left','jf_right'), 5:('jf_up','jf_down'),
    16:('jf_left','jf_right'), 17:('jf_up','jf_down'),
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

def build_physical_to_xdo(mapping):
    result = {}
    # Nouvelle structure: { deviceName: { jf_up: raw, ... }, ... }
    # On supporte aussi l'ancienne structure plate pour compatibilité
    has_devices = any(isinstance(v, dict) for v in mapping.values() if not str(v).startswith('__'))
    if has_devices:
        for dev_name, dev_map in mapping.items():
            if dev_name.startswith('__') or not isinstance(dev_map, dict): continue
            for jf_id, raw_val in dev_map.items():
                if jf_id.startswith('__') or not raw_val: continue
                xdo = JF_XDO.get(jf_id)
                if not xdo: continue
                if raw_val.startswith('KEY_') or raw_val.startswith('ABS_') or raw_val.startswith('REL_'):
                    result[raw_val] = xdo
    else:
        # Ancienne structure plate
        for jf_id, raw_val in mapping.items():
            if jf_id.startswith('__') or not raw_val: continue
            xdo = JF_XDO.get(jf_id)
            if not xdo: continue
            if raw_val.startswith('KEY_') or raw_val.startswith('ABS_') or raw_val.startswith('REL_'):
                result[raw_val] = xdo
    return result

CDP_PORT = 9222

def cdp_click_active_select():
    """
    Contournement du bug de simulation de clic JS de jellyfin-web :
    sur les <select> HTML natifs, Entrée/Espace envoyés au clavier ne
    déclenchent jamais l'affichage visuel du dropdown (le JS interne de
    Jellyfin génère une séquence mousedown/click buggée qui referme le
    menu juste après l'avoir ouvert). Un vrai clic XTEST à la position
    de document.activeElement fonctionne, donc on le simule via CDP
    (port local 9222, jamais exposé hors de 127.0.0.1) uniquement
    quand l'élément actif est un SELECT.
    Retourne True si le clic CDP a été effectué, False sinon (pour
    laisser l'appelant retomber sur l'envoi de touche classique).
    """
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json", timeout=0.3) as r:
            targets = json.loads(r.read())
        ws_url = next((t["webSocketDebuggerUrl"] for t in targets if t.get("type") == "page"), None)
        if not ws_url:
            return False

        import websocket
        ws = websocket.create_connection(ws_url, timeout=0.5)
        expr = (
            "(function(){var el=document.activeElement;"
            "if(!el||el.tagName!=='SELECT')return null;"
            "var r=el.getBoundingClientRect();"
            "return {x:r.left+r.width/2,y:r.top+r.height/2};})()"
        )
        ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                             "params": {"expression": expr, "returnByValue": True}}))
        result = json.loads(ws.recv())
        ws.close()
        pos = result.get("result", {}).get("result", {}).get("value")
        if not pos:
            return False

        env = os.environ.copy()
        env['DISPLAY'] = ':0'
        x, y = int(pos['x']), int(pos['y'])

        # Verrou pour empêcher xe_cursor_pin.sh de re-piéger le curseur
        # en (0,0) pendant qu'on le positionne intentionnellement sur
        # l'élément à cliquer.
        LOCK_FILE = '/tmp/xe_cdp_click.lock'
        try:
            with open(LOCK_FILE, 'w') as f:
                f.write('1')
            subprocess.run(['xdotool', 'mousemove', str(x), str(y)], timeout=0.5, env=env, capture_output=True)
            subprocess.run(['xdotool', 'click', '1'], timeout=0.5, env=env, capture_output=True)
            # Laisser le navigateur enregistrer le clic avant de
            # libérer le verrou et de re-cacher le curseur.
            time.sleep(0.08)
            subprocess.run(['xdotool', 'mousemove', '0', '0'], timeout=0.5, env=env, capture_output=True)
        finally:
            try: os.remove(LOCK_FILE)
            except Exception: pass
        return True
    except Exception:
        # CDP indisponible, élément non-select, timeout réseau, etc.
        # On laisse l'appelant retomber sur le comportement clavier classique.
        return False

def send_key(xdo_key):
    if not xdo_key: return
    try:
        # Pour la touche de validation (jf_ok -> Return), on tente d'abord
        # le clic CDP qui contourne le bug des <select> natifs. S'il
        # n'aboutit pas (pas de select actif, CDP indisponible), on
        # continue normalement avec l'envoi de touche clavier ci-dessous.
        if xdo_key == 'Return' and cdp_click_active_select():
            return

        wins = subprocess.run(
            ['xdotool', 'search', '--class', 'jellyfin'],
            capture_output=True, text=True, timeout=0.3
        ).stdout.splitlines()
        wins = [w for w in wins if w.strip().isdigit()]
        active = subprocess.run(
            ['xdotool', 'getactivewindow'],
            capture_output=True, text=True, timeout=0.3
        ).stdout.strip()
        win = active if active in wins else (wins[-1] if wins else None)
        if win:
            subprocess.run(['xdotool','key','--window',win,'--clearmodifiers',xdo_key],
                timeout=0.3, capture_output=True)
        else:
            subprocess.run(['xdotool','key','--clearmodifiers',xdo_key],
                timeout=0.3, capture_output=True)
    except Exception as e:
        print(f'[xe_jmp_input] xdotool error: {e}', flush=True)

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
        if key not in _name_seen: _name_seen[key] = dev_path; return True
        if event_num(dev_path) < event_num(_name_seen[key]): _name_seen[key] = dev_path; return True
        return False

def release_device(name, dev_path):
    key = name.strip().lower()
    with _name_seen_lock:
        if _name_seen.get(key) == dev_path: del _name_seen[key]

def watch(dev_path, stop_event):
    dev_name = None
    try:
        dev = InputDevice(dev_path)
        dev_name = dev.name
        if should_exclude(dev_name) or is_unmappable(dev_name): return
        if not claim_device(dev_name, dev_path): return
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
            mapping  = load_mapping()
            phys_map = build_physical_to_xdo(mapping)
            if event.type == ecodes.EV_KEY and event.value == 1:
                raw = f'KEY_{event.code}'
                xdo = phys_map.get(raw)
                if xdo:
                    send_key(xdo)
                else:
                    jf_id = KEY_TO_JF.get(event.code)
                    if jf_id: send_key(JF_XDO.get(jf_id))
            elif event.type == ecodes.EV_ABS and event.code in ABS_TO_JF:
                rng = axis_range.get(event.code, (-32767,32767))
                mn,mx = rng; mid=(mn+mx)/2; span=(mx-mn)/2 or 1
                norm=(event.value-mid)/span; DEAD=0.25
                neg_jf, pos_jf = ABS_TO_JF[event.code]
                now=time.monotonic(); last_t=axis_time.get(event.code,0)
                if abs(norm)<DEAD:
                    axis_state[event.code]=None
                elif norm<-DEAD and axis_state.get(event.code)!=neg_jf and now-last_t>COOL:
                    axis_state[event.code]=neg_jf; axis_time[event.code]=now
                    raw = f'ABS_{event.code}_neg'
                    xdo = phys_map.get(raw) or JF_XDO.get(neg_jf)
                    if xdo: send_key(xdo)
                elif norm>DEAD and axis_state.get(event.code)!=pos_jf and now-last_t>COOL:
                    axis_state[event.code]=pos_jf; axis_time[event.code]=now
                    raw = f'ABS_{event.code}_pos'
                    xdo = phys_map.get(raw) or JF_XDO.get(pos_jf)
                    if xdo: send_key(xdo)
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
