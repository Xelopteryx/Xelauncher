#!/usr/bin/env python3
# xe_input.py — Lecteur evdev universel pour XeLauncher Prometheus
import os, sys, json, glob, threading, time
try:
    from evdev import InputDevice, ecodes
except ImportError:
    sys.stderr.write("pip install evdev\n"); sys.exit(1)

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
    sys.stdout.write(json.dumps({'device':device,'name':dev_name,'action':action,'raw':raw or action})+'\n')
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
