#!/bin/bash

# Fond noir immédiat dès X11, avant qu'Electron ouvre sa fenêtre.
# Sans ça, Xorg affiche son fond blanc par défaut (~100-300ms de flash).

startx /bin/bash -c '
  xsetroot -solid "#0a0a0f"
  xsetroot -cursor_name blank
  exec electron /home/pi/xelauncher/src/main.js
' -- :0 vt1 -nolisten tcp
