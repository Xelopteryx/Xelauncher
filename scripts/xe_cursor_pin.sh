#!/bin/bash
# xe_cursor_pin.sh -- Piège le curseur souris dans le coin (0,0) de l'écran.
#
# Le curseur reste techniquement actif (interaction non bloquée), mais
# est ramené en (0,0) dès qu'il s'écarte -- invisible en pratique dans
# une UI kiosk plein écran où ce coin n'affiche jamais rien.
#
# Respecte le verrou /tmp/xe_cdp_click.lock posé par cdp_click_active_select()
# (dans xe_jmp_input.py) pendant la durée d'un clic CDP simulé sur un
# <select> Jellyfin, pour ne jamais re-piéger le curseur pendant qu'il
# est positionné intentionnellement sur l'élément à cliquer.
#
# Survit à tous les cycles Electron/Jellyfin/RetroPie car lancé depuis
# ~/.xinitrc, indépendamment du cycle de vie de ces applications.

export DISPLAY=:0
INTERVAL=0.15
LOCK_FILE=/tmp/xe_cdp_click.lock

while true; do
    if [ ! -f "$LOCK_FILE" ]; then
        pos=$(xdotool getmouselocation --shell 2>/dev/null)
        x=$(echo "$pos" | grep '^X=' | cut -d= -f2)
        y=$(echo "$pos" | grep '^Y=' | cut -d= -f2)
        if [ "$x" != "0" ] || [ "$y" != "0" ]; then
            xdotool mousemove 0 0 2>/dev/null
        fi
    fi
    sleep "$INTERVAL"
done
