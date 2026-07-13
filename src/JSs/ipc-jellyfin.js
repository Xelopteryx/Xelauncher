/**
 * ipc-jellyfin.js
 * IPC : Jellyfin (lancement, auth, profils, avatars, mapping JD).
 */

'use strict'

const { ipcMain } = require('electron')
const { exec }    = require('child_process')
const http        = require('http')
const https       = require('https')
const path        = require('path')
const fs          = require('fs')
const os          = require('os')

const {
  BASE_DIR, AVATARS_PATH, JF_MAPPING_FILE, SCRIPTS_DIR,
  logDebug, loadProfiles, saveProfiles, ensureDirs,
} = require('./helpers')
const { resolveHTML, getMainWindow, handoffToExternal } = require('./main-window')

/* -- Lancement Jellyfin (profils) -- */
ipcMain.handle('launch-jellyfin', async () => {
  await new Promise(resolve => {
    exec('which tailscale', err => {
      if (err) return resolve()
      exec('sudo systemctl start tailscaled 2>/dev/null', () => {
        exec('sudo tailscale up 2>/dev/null', () => resolve())
      })
    })
  })
  const win = getMainWindow()
  if (win) win.loadFile(resolveHTML('profiles.html'))
})

/* -- Lancement Jellyfin avec token -- */
ipcMain.handle('launch-jellyfin-token', async (_, server, token, userId, serverId, username, password) => {
  logDebug('=== LANCEMENT JELLYFIN ===')
  logDebug(`Server: ${server}  UserId: ${userId}  ServerId: ${serverId}`)

  const JD_WRAPPER = path.join(SCRIPTS_DIR, 'jmp_wrapper.sh')
  try { fs.mkdirSync(SCRIPTS_DIR, { recursive: true }) } catch (e) {}

  const cleanServer = server.replace(/\/+$/, '')

  /* -- 1. Injection LevelDB --
     Stratgie : on tente d'abord d'injecter les credentials frais.
     Si le LevelDB n'existe pas encore (premier lancement), on lance JD
     une premire fois en mode "init" pour qu'il cre sa base, on attend
     qu'il se ferme, puis on injecte et on relance normalement.
     La cl _deviceId2 est prserve  tout prix. */
  const leveldbScript = `
import plyvel, json, time, os, sys, glob as _glob, urllib.request, subprocess, shutil

SERVER    = ${JSON.stringify(cleanServer)}
USERNAME  = ${JSON.stringify(username || '')}
PASSWORD  = ${JSON.stringify(password || '')}
SERVER_ID = ${JSON.stringify(serverId || '')}
HOME      = os.path.expanduser("~")

PROFILE_GLOB = os.path.join(HOME,
    ".var/app/org.jellyfin.JellyfinDesktop/data/jellyfin-desktop/profiles/*/QtWebEngine/Local Storage/leveldb")

def find_leveldb():
    candidates = _glob.glob(PROFILE_GLOB)
    return candidates[0] if candidates else None

db_path = find_leveldb()

# -- Premier lancement : la base n'existe pas encore --
# On lance JD brivement (3s) pour qu'il cre sa structure, puis on kill.
if not db_path:
    print("[leveldb] Base absente  init JD pour crer la structure", flush=True)
    env = os.environ.copy()
    env["DISPLAY"] = ":0"
    env["XAUTHORITY"] = os.path.join(HOME, ".Xauthority")
    proc = subprocess.Popen(
        ["flatpak", "run", "org.jellyfin.JellyfinDesktop"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    # Attendre max 15s que la base soit cre
    for _ in range(30):
        time.sleep(0.5)
        db_path = find_leveldb()
        if db_path:
            break
    proc.terminate()
    try: proc.wait(timeout=5)
    except: proc.kill()
    time.sleep(1)  # laisser LevelDB se fermer proprement
    db_path = find_leveldb()

if not db_path:
    print("[leveldb] Base toujours introuvable aprs init", flush=True)
    sys.exit(1)

print("[leveldb] Base : " + db_path, flush=True)

# -- Ouvrir LevelDB avec retry (JD peut avoir le lock) --
db = None
for _i in range(8):
    try:
        db = plyvel.DB(db_path)
        break
    except Exception as _e:
        if _i == 7:
            print("[leveldb] lock persistant: " + str(_e), flush=True)
            sys.exit(1)
        time.sleep(1)

SEP  = bytes([0, 1])
MARK = bytes([1])
def lkey(o, n): return b"_" + o.encode() + SEP + n.encode()
def lval(v):    return MARK + v.encode()

# -- Rcuprer le DeviceId existant --
dev_raw = db.get(lkey(SERVER, "_deviceId2"))

# Si pas de deviceId pour ce serveur, chercher n'importe quel deviceId
if not dev_raw or len(dev_raw) < 2:
    print("[leveldb] _deviceId2 absent pour ce serveur, recherche globale", flush=True)
    for key, value in db:
        if b"_deviceId2" in key and value and len(value) > 1:
            dev_raw = value
            print("[leveldb] deviceId trouv via scan", flush=True)
            break

DEVICE_ID_B64 = dev_raw[1:].decode("utf-8") if dev_raw and len(dev_raw) > 1 else "xelauncher-jd-default"
print("[leveldb] DeviceId: " + DEVICE_ID_B64[:50], flush=True)

# -- R-authentifier avec le DeviceId du client --
auth_hdr = 'MediaBrowser Client="JellyfinDesktop", Device="Prometheus", DeviceId="' + DEVICE_ID_B64 + '", Version="2.0.0"'
req = urllib.request.Request(
    SERVER + "/Users/AuthenticateByName",
    data=json.dumps({"Username": USERNAME, "Pw": PASSWORD}).encode(),
    headers={"Content-Type": "application/json", "X-Emby-Authorization": auth_hdr},
    method="POST"
)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        res = json.loads(r.read())
    fresh_token = res["AccessToken"]
    fresh_uid   = res["User"]["Id"]
    fresh_sid   = res.get("ServerId", SERVER_ID)
    print("[leveldb] auth OK uid=" + fresh_uid, flush=True)
except Exception as e:
    print("[leveldb] auth failed: " + str(e), flush=True)
    # On continue avec le token existant passé en paramètre.
    # IMPORTANT : ne pas fermer db ici, l'écriture batch plus bas
    # en a encore besoin (c'était la cause du "Database is closed").
    fresh_token = ${JSON.stringify(token)}
    fresh_uid   = ${JSON.stringify(userId || '')}
    fresh_sid   = SERVER_ID

now = int(time.time() * 1000)
creds = json.dumps({"Servers": [{
    "DateLastAccessed": now,
    "LastConnectionMode": 2,
    "ManualAddress": SERVER,
    "manualAddressOnly": True,
    "Name": "jellyfin",
    "Id": fresh_sid,
    "AccessToken": fresh_token,
    "UserId": fresh_uid,
    "LocalAddress": SERVER,
}]}, separators=(",", ":"))

# -- criture chirurgicale : uniquement les cls credentials --
# On ne touche pas  webMode, layout, streaming settings, etc.
wb = db.write_batch()
# Nettoyer les anciennes entres mal formes
for old_k in ["jellyfin_credentials", "enableAutoLogin"]:
    wb.delete(("_" + SERVER + old_k).encode())
# crire les nouvelles entres dans le bon format
wb.put(lkey(SERVER, "jellyfin_credentials"), lval(creds))
wb.put(lkey(SERVER, "enableAutoLogin"),      lval("true"))
wb.put(lkey(SERVER, "layout"),               lval("tv"))
# Prserver le deviceId
if dev_raw:
    wb.put(lkey(SERVER, "_deviceId2"), dev_raw)
wb.write()
db.close()
print("[leveldb] Injection OK uid=" + fresh_uid, flush=True)
`

  await new Promise(resolve => {
    const tmp = path.join(os.tmpdir(), 'xe_leveldb.py')
    fs.writeFileSync(tmp, leveldbScript)
    exec(`python3 "${tmp}"`, (err, out) => {
      logDebug(out ? out.trim() : '')
      if (err) logDebug(`LevelDB err: ${err.message}`)
      resolve()
    })
  })

  /* -- 2. Wrapper bash --
     - Attend que X11 soit disponible (xdpyinfo en boucle)
     - Lance JD une seule fois proprement
     Le dlai de 20-40s venait du crash xcb en boucle car DISPLAY
     n'tait pas propag et X11 n'tait pas encore prt aprs
     la fermeture d'Electron. */
  const JMP_INPUT_SCRIPT = path.join(SCRIPTS_DIR, 'xe_jmp_input.py')

  // crire xe_jmp_input.py
  try {
    fs.writeFileSync(JMP_INPUT_SCRIPT, buildJmpInputScript(), { mode: 0o755 })
    logDebug('xe_jmp_input.py crit')
  } catch (e) { logDebug(`Erreur criture xe_jmp_input: ${e.message}`) }

  const JD_LOG = path.join(BASE_DIR, 'logs', 'jd_wrapper.log')
  try { fs.mkdirSync(path.dirname(JD_LOG), { recursive: true }) } catch (e) {}

  const wrapperContent = `#!/bin/bash
export DISPLAY=:0
export XAUTHORITY=/home/xelopteryx/.Xauthority
export XDG_RUNTIME_DIR="/run/user/\$(id -u)"

# -- Capture de toute la sortie (wrapper + JD + script input) --
# Avant ce patch, stdout/stderr de ce script et du flatpak JD
# n'étaient redirigés nulle part une fois lancés depuis .xinitrc :
# aucune trace de crash Qt/QtWebEngine n'était jamais persistée.
JD_LOG="${JD_LOG}"
exec > >(tee -a "\$JD_LOG") 2>&1
echo ""
echo "===== \$(date '+%Y-%m-%d %H:%M:%S') jmp_wrapper démarré (PID \$\$) ====="

# -- Relever la limite de descripteurs de fichiers --
# Constaté : limite héritée à 24 (probablement systemd-logind/PAM via
# .xinitrc), bien en dessous du défaut système usuel (~1024). JD/QtWebEngine
# épuise ce quota en quelques minutes quand le client web Jellyfin retry des
# fetch échoués en boucle serrée pendant la lecture vidéo (chaque tentative
# fuite un fd côté Chromium). Résultat : "Trop de fichiers ouverts (24)",
# puis crash au prochain repaint/interaction. On relève le plafond pour ce
# process avant de lancer JD ; n'affecte que ce sous-shell et ses enfants.
OLD_NOFILE=\$(ulimit -n)
ulimit -n 65536 2>/dev/null || ulimit -n 4096 2>/dev/null
echo "[jd_wrapper] ulimit -n: \${OLD_NOFILE} -> \$(ulimit -n)"

# -- Watchdog fd : redémarrage préventif avant crash --
# Le ulimit ci-dessus ne fait que reculer l'échéance : la vraie fuite
# vient du compositeur GPU (export dmabuf par frame) quand l'overlay/OSD
# est affiché dans le player, hors de contrôle côté XeLauncher. On
# surveille donc le nombre de fds ouverts sur tout l'arbre de processus
# de JD et on le tue proprement (SIGTERM puis SIGKILL) avant qu'il
# n'atteigne la limite et crashe en plein milieu d'une lecture. La
# boucle de tentatives existante se charge ensuite de le relancer.
FD_LIMIT=\$(ulimit -n)
FD_THRESHOLD=\$(( FD_LIMIT * 90 / 100 ))
WATCHDOG_FLAG="/tmp/xe_jd_watchdog_flag_\$\$"
WATCHDOG_RESTARTS=0
MAX_WATCHDOG_RESTARTS=10
rm -f "\$WATCHDOG_FLAG" 2>/dev/null

fd_descendants() {
    local pid=\$1
    echo "\$pid"
    for c in \$(pgrep -P "\$pid" 2>/dev/null); do
        fd_descendants "\$c"
    done
}

fd_count_tree() {
    local root=\$1
    local total=0
    local p c
    for p in \$(fd_descendants "\$root"); do
        if [ -d "/proc/\$p/fd" ]; then
            c=\$(ls "/proc/\$p/fd" 2>/dev/null | wc -l)
            total=\$(( total + c ))
        fi
    done
    echo \$total
}

# -- Détail par type de fd --
# fd_count_tree seul dit COMBIEN de fds sont ouverts, pas LESQUELS. Pour
# distinguer un vrai leak GPU (dmabuf/DRM par frame) d'autre chose (sockets
# réseau, timers Qt, etc.) sans avoir à brancher un outil externe, on
# catégorise chaque fd via readlink et on logue la répartition directement
# dans jd_wrapper.log. Un peu plus coûteux que le simple \`wc -l\`, donc on
# ne l'appelle pas à chaque tick de la boucle watchdog (voir plus bas).
fd_breakdown_tree() {
    local root=\$1
    local dri=0 sock=0 evfd=0 pipe=0 reg=0 dmabuf=0 other=0
    local p f target
    for p in \$(fd_descendants "\$root"); do
        [ -d "/proc/\$p/fd" ] || continue
        for f in "/proc/\$p/fd/"*; do
            [ -e "\$f" ] || continue
            target=\$(readlink "\$f" 2>/dev/null) || continue
            case "\$target" in
                */dev/dri/*)            dri=\$((dri + 1)) ;;
                socket:*)               sock=\$((sock + 1)) ;;
                anon_inode:\[eventfd\]*) evfd=\$((evfd + 1)) ;;
                *dmabuf*)               dmabuf=\$((dmabuf + 1)) ;;
                pipe:*)                 pipe=\$((pipe + 1)) ;;
                /*)                     reg=\$((reg + 1)) ;;
                *)                      other=\$((other + 1)) ;;
            esac
        done
    done
    echo "\$dri \$sock \$evfd \$pipe \$reg \$dmabuf \$other"
}

# -- Échantillon détaillé des cibles anon_inode à l'ALERTE --
# Appelé une seule fois, au moment critique : liste les libellés anon_inode/
# other les plus fréquents sur l'arbre JD, pour confirmer sans ambiguïté
# quel sous-type de fd domine (dmabuf, sync_file, memfd, etc.) sans avoir
# à rejouer une session avec un outil externe.
fd_top_targets() {
    local root=\$1
    local p f target
    {
        for p in \$(fd_descendants "\$root"); do
            [ -d "/proc/\$p/fd" ] || continue
            for f in "/proc/\$p/fd/"*; do
                [ -e "\$f" ] || continue
                readlink "\$f" 2>/dev/null
            done
        done
    } | sed -E 's/\[[0-9]+\]/[N]/' | sort | uniq -c | sort -rn | head -5
}

fd_watchdog() {
    local root=\$1
    local flag=\$2
    local tick=0
    while kill -0 "\$root" 2>/dev/null; do
        FD_COUNT=\$(fd_count_tree "\$root")
        tick=\$((tick + 1))
        # Échantillon détaillé toutes les ~30s (tick * sleep 5s) pendant
        # toute la session, pas seulement à l'alerte : on veut voir la
        # courbe monter, pas juste le pic final.
        if [ \$(( tick % 6 )) -eq 0 ]; then
            read -r B_DRI B_SOCK B_EVFD B_PIPE B_REG B_DMABUF B_OTHER <<< "\$(fd_breakdown_tree "\$root")"
            echo "[jd_wrapper] fd détail (\${FD_COUNT}/\${FD_LIMIT}): dri=\${B_DRI} socket=\${B_SOCK} eventfd=\${B_EVFD} pipe=\${B_PIPE} fichier=\${B_REG} dmabuf=\${B_DMABUF} autre=\${B_OTHER}"
        fi
        if [ "\$FD_COUNT" -ge "\$FD_THRESHOLD" ]; then
            read -r B_DRI B_SOCK B_EVFD B_PIPE B_REG B_DMABUF B_OTHER <<< "\$(fd_breakdown_tree "\$root")"
            echo "[jd_wrapper] ALERTE fd: \${FD_COUNT}/\${FD_LIMIT} ouverts sur l'arbre JD (pid \$root) — dri=\${B_DRI} socket=\${B_SOCK} eventfd=\${B_EVFD} pipe=\${B_PIPE} fichier=\${B_REG} dmabuf=\${B_DMABUF} autre=\${B_OTHER} — redémarrage préventif"
            echo "[jd_wrapper] fd top targets:"
            fd_top_targets "\$root" | while read -r line; do echo "[jd_wrapper]   \$line"; done
            touch "\$flag"
            # Important : tuer TOUT l'arbre, pas seulement \$root. flatpak run
            # peut détacher ses processus enfants (Zygote, GPU process,
            # renderer) hors du groupe de processus du lanceur — un kill sur
            # \$root seul ne tue que le lanceur et laisse la vraie fenêtre JD
            # (et la fuite de fds sous-jacente) continuer à tourner en orphelin,
            # pendant que ce script croit JD terminé et relance/rend la main.
            local pids
            pids=\$(fd_descendants "\$root")
            for p in \$(echo "\$pids" | tac); do
                kill -TERM "\$p" 2>/dev/null
            done
            sleep 2
            for p in \$(echo "\$pids" | tac); do
                kill -KILL "\$p" 2>/dev/null
            done
            return
        fi
        sleep 5
    done
}

# -- Attendre que X11 soit réellement joignable (max 10s) --
# xdg-desktop-portal et xdg-desktop-portal-gtk tournent déjà en
# permanence depuis le boot (systemd user units) : on ne les
# touche plus ici. Les tuer/relancer dans ce sous-shell risquait
# de les faire repartir sans le bon environnement de session
# (XDG_CURRENT_DESKTOP, bus D-Bus), ce qui cassait le rendu des
# sous-menus QtWebEngine.
for i in \$(seq 1 20); do
    if DISPLAY=:0 xdpyinfo >/dev/null 2>&1; then
        echo "[jd_wrapper] X11 prêt (tentative \$i)"
        break
    fi
    sleep 0.5
done

# -- Attendre que le GPU soit libéré par Electron (max 5s) --
# Le V3D n'a qu'un contexte KMS/DRM exclusif : xelauncher.sh enchaîne
# quasi instantanément "Electron terminé" -> lancement de ce wrapper,
# mais le process GPU d'Electron peut mettre 1-2s de plus à relâcher
# /dev/dri après app.quit(). Si JD/mpv tente d'acquérir le device
# pendant ce court intervalle, l'init de la fenêtre vidéo échoue tout
# de suite (SIGSEGV en 2-8s) -- ce sont les deux premiers crashs
# systématiques observés à chaque lancement. On attend ici que plus
# aucun process n'ait les device nodes DRM ouverts avant le premier
# essai ; si fuser n'est pas dispo ou que ça traîne, on tente quand
# même (mieux vaut essayer que bloquer indéfiniment).
if command -v fuser >/dev/null 2>&1; then
    for i in \$(seq 1 10); do
        GPU_BUSY=0
        for dev in /dev/dri/card* /dev/dri/renderD*; do
            [ -e "\$dev" ] || continue
            if fuser "\$dev" >/dev/null 2>&1; then
                GPU_BUSY=1
            fi
        done
        if [ "\$GPU_BUSY" -eq 0 ]; then
            echo "[jd_wrapper] GPU libre (tentative \$i)"
            break
        fi
        sleep 0.5
    done
else
    echo "[jd_wrapper] fuser absent, attente GPU ignorée"
fi

# Lancer Jellyfin en arrière-plan
JMP_INPUT_SCRIPT="${JMP_INPUT_SCRIPT}"
JF_MAPPING_FILE="${JF_MAPPING_FILE}"
REMAP_PID=""

MAX_ATTEMPTS=5
ATTEMPT=0
while [ \$ATTEMPT -lt \$MAX_ATTEMPTS ]; do
    ATTEMPT=\$((ATTEMPT + 1))
    echo "[jd_wrapper] Tentative \$ATTEMPT/\$MAX_ATTEMPTS..."
    START=\$(date +%s)

    # Lancer JD en arrière-plan
    # --remote-debugging-port=9222 : écoute uniquement sur 127.0.0.1 par défaut
    # (jamais exposé sur le réseau/Tailscale). Utilisé uniquement par
    # xe_jmp_input.py en local sur le Pi pour contourner le bug de
    # simulation de clic JS de jellyfin-web sur les <select> natifs
    # (Entrée/Espace n'ouvre pas le dropdown visuellement, voir #128/#253
    # sur jellyfin/jellyfin-desktop : "weird mouse input emulator").
    # --disable-gpu-compositing : coupe le chemin d'export dma-buf du
    # compositeur QtWebEngine/Chromium (gbm_wrapper.cc "Failed to export
    # buffer to dma_buf", bug connu et répandu sur pilotes V3D/Mesa RPi).
    # Chaque échec d'export laissait une fence anon_inode:sync_file ouverte
    # — confirmé via fd_breakdown_tree (sync_file = 99.8% de la fuite,
    # dmabuf lui-même restait stable à 2). Le décodage vidéo matériel n'est
    # pas concerné, seul le compositing/l'affichage passe en logiciel.
    flatpak run --env=QT_QPA_PLATFORMTHEME= --env=XDG_CURRENT_DESKTOP=GNOME --env=QTWEBENGINE_CHROMIUM_FLAGS="--disable-gpu-compositing" org.jellyfin.JellyfinDesktop --remote-debugging-port=9222 &
    JD_PID=\$!

    fd_watchdog "\$JD_PID" "\$WATCHDOG_FLAG" &
    WATCHDOG_PID=\$!
    rm -f "\$WATCHDOG_FLAG" 2>/dev/null

    # Attendre que la fenêtre JD soit visible avant de démarrer le daemon input (max 20s)
    WIN=""
    for i in \$(seq 1 40); do
        sleep 0.5
        WIN=\$(DISPLAY=:0 xdotool search --class jellyfin 2>/dev/null | tail -1)
        if [ -n "\$WIN" ]; then
            echo "[jd_wrapper] Fenêtre JD détectée: \$WIN"
            break
        fi
    done

    # Démarrer le daemon de remapping evdev → xdotool
    if command -v python3 >/dev/null && [ -f "\$JMP_INPUT_SCRIPT" ]; then
        python3 "\$JMP_INPUT_SCRIPT" "\$JF_MAPPING_FILE" &
        REMAP_PID=\$!
        echo "[jd_wrapper] xe_jmp_input PID=\$REMAP_PID"
    fi

    wait \$JD_PID
    JD_EXIT=\$?
    END=\$(date +%s)
    RUNTIME=\$((END - START))
    if [ \$JD_EXIT -ge 128 ]; then
        SIG=\$((JD_EXIT - 128))
        echo "[jd_wrapper] JD terminé après \${RUNTIME}s — TUÉ PAR SIGNAL \$SIG (exit=\$JD_EXIT)"
    else
        echo "[jd_wrapper] JD terminé après \${RUNTIME}s (exit=\$JD_EXIT)"
    fi

    # Arrêter le daemon de remapping et le watchdog entre les tentatives
    if [ -n "\$REMAP_PID" ]; then
        kill "\$REMAP_PID" 2>/dev/null
        wait "\$REMAP_PID" 2>/dev/null
        REMAP_PID=""
    fi
    if [ -n "\$WATCHDOG_PID" ]; then
        kill "\$WATCHDOG_PID" 2>/dev/null
        wait "\$WATCHDOG_PID" 2>/dev/null
        WATCHDOG_PID=""
    fi

    # -- Cas spécial : redémarrage déclenché par le watchdog fd --
    # Contrairement à une fermeture volontaire ou un vrai crash, ce
    # redémarrage ne doit ni compter comme une tentative ratée, ni
    # renvoyer au menu XeLauncher : on relance JD tout de suite, en
    # silence, pour que ça reste invisible pour l'utilisateur.
    if [ -f "\$WATCHDOG_FLAG" ]; then
        rm -f "\$WATCHDOG_FLAG"
        WATCHDOG_RESTARTS=\$((WATCHDOG_RESTARTS + 1))
        echo "[jd_wrapper] Redémarrage préventif watchdog fd (#\${WATCHDOG_RESTARTS}) — relance immédiate de JD"
        if [ "\$WATCHDOG_RESTARTS" -ge "\$MAX_WATCHDOG_RESTARTS" ]; then
            echo "[jd_wrapper] Trop de redémarrages watchdog (\${WATCHDOG_RESTARTS}) — abandon, retour au menu"
            break
        fi
        ATTEMPT=\$((ATTEMPT - 1))
        continue
    fi

    # -- Décision : relancer ou rendre la main --
    # exit=0 (arrêt propre, pas de signal) ne peut être qu'une fermeture
    # volontaire de JD (bouton quitter, alt+F4, etc.) : on ne relance
    # JAMAIS dans ce cas, même si ça a duré 2s. Avant ce fix, le
    # garde-fou "RUNTIME > 15s" traitait toute fermeture rapide comme un
    # crash au démarrage et relançait automatiquement — ce qui, si
    # l'utilisateur fermait JD volontairement plusieurs fois de suite
    # (ex: pour re-tester après un vrai crash), le forçait à refermer
    # une fenêtre qui se rouvrait toute seule à chaque fois.
    if [ \$JD_EXIT -eq 0 ]; then
        echo "[jd_wrapper] Sortie normale (fermeture volontaire, \${RUNTIME}s)"
        break
    fi

    # Ici, JD_EXIT != 0 : soit un vrai crash (signal), soit une erreur.
    # On ne relance automatiquement que si ça a échoué vite (échec de
    # démarrage, ex: course GPU) ; un crash après une session longue
    # rend la main plutôt que de relancer en boucle sans supervision.
    if [ \$RUNTIME -gt 15 ]; then
        echo "[jd_wrapper] Sortie anormale après une session longue (\${RUNTIME}s) — retour au menu"
        break
    fi
    echo "[jd_wrapper] Démarrage trop court (\${RUNTIME}s), réessai dans 1s..."
    sleep 1
done

`

  try {
    fs.writeFileSync(JD_WRAPPER, wrapperContent, { mode: 0o755 })
    logDebug('Wrapper JD crit')
  } catch (e) { logDebug(`Erreur criture wrapper: ${e.message}`) }

  handoffToExternal(`bash "${JD_WRAPPER}"`)
  return true
})

/* -- Auth Jellyfin -- */
ipcMain.handle('jellyfin-authenticate', async (_, server, username, password) => {
  logDebug(`Auth: ${username} ? ${server}`)
  return new Promise(resolve => {
    try {
      const u    = new URL(server + '/Users/AuthenticateByName')
      const body = JSON.stringify({ Username: username, Pw: password })
      const lib  = u.protocol === 'https:' ? https : http
      const req  = lib.request({
        hostname: u.hostname,
        port:     u.port || (u.protocol === 'https:' ? 443 : 80),
        path:     u.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':         'application/json',
          'Content-Length':       Buffer.byteLength(body),
          'X-Emby-Authorization': 'MediaBrowser Client="XeLauncher", Device="RPI5", DeviceId="xelauncher-rpi5", Version="2.0.0"',
        },
      }, res => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try {
            const j = JSON.parse(data)
            if (j.AccessToken) resolve({
              ok: true,
              accessToken: j.AccessToken,
              userId:      j.User?.Id,
              userName:    j.User?.Name,
              serverId:    j.ServerId,
            })
            else resolve({ ok: false, error: j.message || 'Authentification refuse' })
          } catch (e) { resolve({ ok: false, error: 'Rponse invalide' }) }
        })
      })
      req.on('error', e => resolve({ ok: false, error: e.message }))
      req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'Dlai dpass' }) })
      req.write(body); req.end()
    } catch (e) { resolve({ ok: false, error: 'URL invalide' }) }
  })
})

/* -- Profils -- */
ipcMain.handle('get-profiles', async () => loadProfiles())

ipcMain.handle('save-profile', async (_, profile) => {
  const data = loadProfiles()
  const idx  = data.profiles.findIndex(p => p.id === profile.id)
  if (idx >= 0) data.profiles[idx] = profile; else data.profiles.push(profile)
  saveProfiles(data); return true
})

ipcMain.handle('delete-profile', async (_, id) => {
  const data = loadProfiles()
  data.profiles = data.profiles.filter(p => p.id !== id)
  saveProfiles(data); return true
})


/* -- Avatars -- */
ipcMain.handle('get-avatars', async () => {
  try {
    if (fs.existsSync(AVATARS_PATH))
      return fs.readdirSync(AVATARS_PATH).filter(f => /\.(png|jpg|jpeg)$/i.test(f))
  } catch (e) {}
  return []
})

ipcMain.handle('get-avatar-data', async (_, filename) => {
  try {
    if (!filename || filename.startsWith('builtin_')) return null
    const p = path.join(AVATARS_PATH, filename)
    if (!fs.existsSync(p)) return null
    const data = fs.readFileSync(p)
    const ext  = path.extname(filename).toLowerCase().replace('.', '')
    return `data:image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : 'png'};base64,${data.toString('base64')}`
  } catch (e) { return null }
})

/* -- Mapping Jellyfin -- */
ipcMain.handle('save-jf-mapping', async (_, mapping) => {
  try {
    fs.writeFileSync(JF_MAPPING_FILE, JSON.stringify(mapping, null, 2), 'utf8')
    logDebug('jfmapping.json sauvegard')
    return true
  } catch (e) {
    logDebug('save-jf-mapping error: ' + e.message)
    return false
  }
})

ipcMain.handle('load-jf-mapping', async () => {
  try {
    if (fs.existsSync(JF_MAPPING_FILE))
      return JSON.parse(fs.readFileSync(JF_MAPPING_FILE, 'utf8'))
  } catch (e) { logDebug('load-jf-mapping error: ' + e.message) }
  return {}
})

/* -- Script Python xe_jmp_input.py -- */
function buildJmpInputScript() {
  return `#!/usr/bin/env python3
# xe_jmp_input.py -- Remapping evdev -> xdotool pour Jellyfin Desktop
import sys, os, json, threading, time, glob, subprocess
try:
    from evdev import InputDevice, ecodes
except ImportError:
    sys.stderr.write("pip install evdev\\n"); sys.exit(1)

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
`
}