#!/usr/bin/env python3
"""
Wiimote controller for Jellyfin Media Player
Detects Wiimote dynamically and maps buttons to keyboard events
"""

import os
import sys
import time
import re
import signal
import subprocess
from evdev import InputDevice, ecodes, UInput, list_devices

# Mapping des boutons Wiimote vers les touches clavier
MAPPING = {
    # Navigation (croix directionnelle)
    ecodes.KEY_UP: ecodes.KEY_UP,
    ecodes.KEY_DOWN: ecodes.KEY_DOWN,
    ecodes.KEY_LEFT: ecodes.KEY_LEFT,
    ecodes.KEY_RIGHT: ecodes.KEY_RIGHT,

    # Boutons A et B
    ecodes.BTN_SOUTH: ecodes.KEY_ENTER,      # A = Valider
    ecodes.BTN_EAST: ecodes.KEY_ESC,         # B = Retour/Annuler

    # Boutons 1 et 2 (alternatives)
    ecodes.BTN_1: ecodes.KEY_ENTER,
    ecodes.BTN_2: ecodes.KEY_ESC,

    # Touches speciales
    ecodes.BTN_MODE: ecodes.KEY_HOME,        # Home = Menu principal
    ecodes.KEY_PREVIOUS: ecodes.KEY_J,       # Previous = J
    ecodes.KEY_NEXT: ecodes.KEY_L,           # Next = L

    # Plus et Moins (utiliser les touches du clavier)
    ecodes.KEY_EQUAL: ecodes.KEY_NEXT,       # + = Next
    ecodes.KEY_MINUS: ecodes.KEY_PREVIOUS,   # - = Previous
}

# Codes alternatifs pour la Wiimote (afficher les codes non mappes pour debug)
DEBUG_UNMAPPED = True

def find_wiimote():
    """Find Wiimote device dynamically"""
    # Method 1: Use evdev to list devices
    try:
        devices = [InputDevice(path) for path in list_devices()]
        for dev in devices:
            name = dev.name.lower()
            if 'nintendo' in name and 'wii' in name and 'remote' in name:
                if 'accelerometer' not in name and 'ir' not in name and 'motion' not in name:
                    print(f"[Wiimote] Found: {dev.path} - {dev.name}", file=sys.stderr)
                    dev.close()
                    return dev.path
    except Exception as e:
        print(f"[Wiimote] Error scanning evdev: {e}", file=sys.stderr)

    # Method 2: Read /proc/bus/input/devices
    try:
        with open('/proc/bus/input/devices', 'r') as f:
            content = f.read()

        blocks = content.split('\n\n')
        for block in blocks:
            if 'Nintendo Wii Remote' in block and 'Handlers=' in block:
                if 'Accelerometer' in block or 'IR' in block or 'Motion Plus' in block:
                    continue

                match = re.search(r'event(\d+)', block)
                if match:
                    event_path = f'/dev/input/event{match.group(1)}'
                    print(f"[Wiimote] Found: {event_path}", file=sys.stderr)
                    return event_path
    except Exception as e:
        print(f"[Wiimote] Error reading proc: {e}", file=sys.stderr)

    # Method 3: Try common event numbers
    for i in range(7, 13):
        path = f'/dev/input/event{i}'
        try:
            dev = InputDevice(path)
            name = dev.name.lower()
            if 'nintendo' in name and 'wii' in name:
                dev.close()
                print(f"[Wiimote] Found: {path}", file=sys.stderr)
                return path
        except:
            continue

    return None

class WiimoteController:
    def __init__(self):
        self.device = None
        self.ui = None
        self.running = True
        self.event_path = None

        signal.signal(signal.SIGTERM, self.signal_handler)
        signal.signal(signal.SIGINT, self.signal_handler)

    def signal_handler(self, sig, frame):
        print("\n[Wiimote] Stop requested", file=sys.stderr)
        self.running = False
        self.cleanup()
        sys.exit(0)

    def setup(self):
        """Initialize Wiimote connection"""
        self.event_path = find_wiimote()
        if not self.event_path:
            print("[Wiimote] No Wiimote found", file=sys.stderr)
            return False

        try:
            self.device = InputDevice(self.event_path)
            print(f"[Wiimote] Connected to {self.event_path} - {self.device.name}", file=sys.stderr)
        except Exception as e:
            print(f"[Wiimote] Connection error: {e}", file=sys.stderr)
            return False

        try:
            self.ui = UInput()
            print("[Wiimote] Virtual keyboard device created", file=sys.stderr)
        except Exception as e:
            print(f"[Wiimote] UInput error: {e}", file=sys.stderr)
            print("[Wiimote] Try: sudo modprobe uinput", file=sys.stderr)
            return False

        return True

    def get_key_name(self, code):
        """Get key name from code for debugging"""
        names = {
            ecodes.KEY_UP: "UP",
            ecodes.KEY_DOWN: "DOWN",
            ecodes.KEY_LEFT: "LEFT",
            ecodes.KEY_RIGHT: "RIGHT",
            ecodes.KEY_ENTER: "ENTER",
            ecodes.KEY_ESC: "ESC",
            ecodes.KEY_HOME: "HOME",
            ecodes.KEY_NEXT: "NEXT",
            ecodes.KEY_PREVIOUS: "PREVIOUS",
        }
        return names.get(code, str(code))

    def send_key(self, key_code, value):
        """Send keyboard event"""
        if self.ui:
            try:
                self.ui.write(ecodes.EV_KEY, key_code, value)
                self.ui.syn()
                if value == 1:
                    print(f"[Wiimote] Key sent: {self.get_key_name(key_code)}", file=sys.stderr)
            except Exception as e:
                print(f"[Wiimote] Error sending key: {e}", file=sys.stderr)

    def map_button(self, code):
        """Map Wiimote button to keyboard key"""
        if code in MAPPING:
            return MAPPING[code]
        return None

    def run(self):
        """Main loop"""
        if not self.setup():
            print("[Wiimote] Cannot start", file=sys.stderr)
            return

        print("[Wiimote] Active - Press Wiimote buttons", file=sys.stderr)
        print("[Wiimote] Press Ctrl+C to stop", file=sys.stderr)

        try:
            for event in self.device.read_loop():
                if not self.running:
                    break

                if event.type != ecodes.EV_KEY:
                    continue

                if event.value == 2:  # Repeat event, ignore
                    continue

                if not os.path.exists(self.event_path):
                    print("[Wiimote] Wiimote disconnected", file=sys.stderr)
                    break

                key_code = self.map_button(event.code)

                if key_code:
                    self.send_key(key_code, event.value)
                else:
                    if event.value == 1 and DEBUG_UNMAPPED:
                        print(f"[Wiimote] Unmapped button code: {event.code}", file=sys.stderr)

        except KeyboardInterrupt:
            print("\n[Wiimote] User interrupt", file=sys.stderr)
        except Exception as e:
            print(f"[Wiimote] Loop error: {e}", file=sys.stderr)
        finally:
            self.cleanup()

    def cleanup(self):
        """Cleanup resources"""
        print("[Wiimote] Cleaning up...", file=sys.stderr)
        if self.device:
            self.device.close()
        if self.ui:
            self.ui.close()
        print("[Wiimote] Stopped", file=sys.stderr)

def monitor_and_run():
    """Monitor Wiimote connection and auto-restart"""
    while True:
        controller = WiimoteController()
        if not controller.setup():
            print("[Wiimote] No Wiimote found, waiting...", file=sys.stderr)
            time.sleep(5)
            continue

        controller.run()
        print("[Wiimote] Reconnecting in 5 seconds...", file=sys.stderr)
        time.sleep(5)

def main():
    """Main function"""
    # Check if uinput is loaded
    try:
        with open('/proc/modules', 'r') as f:
            if 'uinput' not in f.read():
                print("[Wiimote] Loading uinput module...", file=sys.stderr)
                subprocess.run(['sudo', 'modprobe', 'uinput'], check=True)
    except:
        pass

    print("[Wiimote] Wiimote service for Jellyfin started", file=sys.stderr)

    try:
        monitor_and_run()
    except KeyboardInterrupt:
        print("\n[Wiimote] Service stopped", file=sys.stderr)
        sys.exit(0)

if __name__ == "__main__":
    main()
