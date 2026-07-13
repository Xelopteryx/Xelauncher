#!/usr/bin/env python3
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
