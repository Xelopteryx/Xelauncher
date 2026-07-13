#!/usr/bin/env python3
"""
xe_cursor_pin.py -- Neutralise le curseur souris de façon permanente.

Combine deux mécanismes pour une garantie peu importe le contenu
affiché à l'écran :
  1. Masquage visuel réel via XFixesHideCursor (le curseur n'est
     jamais peint, quel que soit l'endroit où il se trouve).
  2. Piège de position en (0,0), pour rester cohérent avec les clics
     CDP simulés sur les <select> Jellyfin et neutraliser le hover
     résiduel de certaines apps.

XFixesHideCursor n'est PAS permanent : la plupart des applications
(QtWebEngine notamment) réinvoquent XFixesShowCursor à chaque
changement de fenêtre/focus, ce qui annule le masquage précédent.
D'où la boucle : on le réimpose en continu plutôt qu'une seule fois.

Contrairement à une boucle bash relançant `python3 -c` à chaque
itération (~80ms de coût de démarrage d'interpréteur par passage),
ce daemon reste résident en mémoire : un seul import au lancement,
puis des appels quasi gratuits en boucle.

Respecte le verrou /tmp/xe_cdp_click.lock posé par
cdp_click_active_select() (dans xe_jmp_input.py) pendant la durée
d'un clic CDP simulé, pour ne jamais interférer avec le
positionnement intentionnel du curseur sur l'élément à cliquer.

Usage : lancé en arrière-plan depuis ~/.xinitrc, avant
"exec xelauncher.sh", pour survivre à tous les cycles de vie
Electron/Jellyfin/RetroPie.
"""
import os
import subprocess
import sys
import time

try:
    from Xlib import display
    from Xlib.ext import xfixes  # noqa: F401 -- l'import enregistre
    # dynamiquement la méthode root.xfixes_hide_cursor() (effet de
    # bord du module au chargement, voir Xlib.ext.xfixes.init()).
except ImportError:
    sys.stderr.write("[xe_cursor_pin] pip install python-xlib --break-system-packages\n")
    sys.exit(1)

INTERVAL = 0.15
LOCK_FILE = '/tmp/xe_cdp_click.lock'

def main():
    os.environ.setdefault('DISPLAY', ':0')
    dpy = display.Display()
    if not dpy.has_extension('XFIXES'):
        sys.stderr.write("[xe_cursor_pin] Extension XFixes indisponible\n")
        sys.exit(1)
    root = dpy.screen().root

    # Le protocole XFixes exige une négociation de version avant
    # d'accepter d'autres requêtes de l'extension (HideCursor inclus).
    # Sans cet appel, le serveur X peut accepter la requête HideCursor
    # sans erreur mais l'ignorer silencieusement.
    try:
        dpy.xfixes_query_version()
        dpy.flush()
    except Exception as e:
        sys.stderr.write(f"[xe_cursor_pin] xfixes_query_version a échoué: {e}\n")

    env = os.environ.copy()
    env['DISPLAY'] = ':0'

    while True:
        if not os.path.exists(LOCK_FILE):
            try:
                root.xfixes_hide_cursor()
                dpy.flush()
            except Exception:
                pass
            try:
                out = subprocess.run(
                    ['xdotool', 'getmouselocation', '--shell'],
                    capture_output=True, text=True, timeout=0.3, env=env
                ).stdout
                x = next((l.split('=')[1] for l in out.splitlines() if l.startswith('X=')), None)
                y = next((l.split('=')[1] for l in out.splitlines() if l.startswith('Y=')), None)
                if x != '0' or y != '0':
                    subprocess.run(['xdotool', 'mousemove', '0', '0'],
                                    timeout=0.3, env=env, capture_output=True)
            except Exception:
                pass
        time.sleep(INTERVAL)

if __name__ == '__main__':
    main()
