#!/bin/bash
# +--------------------------------------------------------------+
# |              XeLauncher — Script d'installation              |
# |           Prometheus Entertainment System — RPI5/PC          |
# +--------------------------------------------------------------+
#
#  Usage : ./install.sh [--i | --u] [--no-retropie | --retropie]
#          curl -fsSL <url>/install.sh | bash -s -- --i --no-retropie
#  (voir --help)

set -uo pipefail

readonly REPO_URL="https://github.com/Xelopteryx/Xelauncher.git"
readonly INSTALL_DIR="$HOME/xelauncher"
readonly LOCK_FILE="/var/tmp/xelauncher_install.lock"
readonly LOG_FILE="$HOME/xelauncher_install.log"
readonly SUDOERS_FILE="/etc/sudoers.d/xelauncher"
readonly PLYMOUTH_THEME_DIR="/usr/share/plymouth/themes/xe_theme"
readonly JELLYFIN_APP_ID="org.jellyfin.JellyfinDesktop"
readonly JELLYFIN_OLD_APP_ID="com.github.iwalton3.jellyfin-media-player"
readonly BOOT_MARK_BEGIN="# >>> XeLauncher boot >>>"
readonly BOOT_MARK_END="# <<< XeLauncher boot <<<"
readonly GETTY_OVERRIDE="/etc/systemd/system/getty@tty1.service.d/override.conf"

readonly RED='\033[1;31m'
readonly GREEN='\033[1;32m'
readonly YELLOW='\033[1;33m'
readonly CYAN='\033[0;36m'
readonly WHITE='\033[1;37m'
readonly RESET='\033[0m'

AUTO_MODE=""
MODE=""
ACTIONS_DONE=()
FAILED_STEPS=()

# RetroPie : optionnel. XE_RETROPIE=yes|no ou --retropie / --no-retropie.
# Vide = on demande (menu interactif) ou on installe (mode --i).
RETROPIE_CHOICE=""
case "${XE_RETROPIE:-}" in yes|no) RETROPIE_CHOICE="$XE_RETROPIE" ;; esac
INSTALL_RETROPIE=1
RETROPIE_INTERRUPTED=0
REMOVE_RETROPIE=0
REMOVE_ROMS=0

log()         { echo -e "${CYAN}→${RESET} $1"; }
ok()          { echo -e "${GREEN}✔${RESET} $1"; }
warn()        { echo -e "${YELLOW}!${RESET} $1"; }
error()       { echo -e "${RED}✖${RESET} $1" >&2; }
done_action() { ACTIONS_DONE+=("$1"); }
fail_action() { FAILED_STEPS+=("$1"); }

section() {
    echo ""
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
    echo -e "${WHITE}$1${RESET}"
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
}

detect_platform() {
    if [[ -f /proc/device-tree/model ]]; then
        local model=$(cat /proc/device-tree/model)
        if echo "$model" | grep -qi "Raspberry Pi 5"; then
            echo "rpi5"
        elif echo "$model" | grep -qi "Raspberry Pi 4"; then
            echo "rpi4"
        elif echo "$model" | grep -qi "Raspberry Pi"; then
            echo "rpi"
        else
            echo "other"
        fi
    else
        echo "pc"
    fi
}

PLATFORM=$(detect_platform)
log "Plateforme détectée: $PLATFORM"

check_disk_space() {
    local required_gb=8
    local available=$(df --output=avail /home 2>/dev/null | tail -1 || df --output=avail / 2>/dev/null | tail -1)
    if [[ -n "$available" ]]; then
        local available_gb=$((available / 1024 / 1024))
        if [[ $available_gb -lt $required_gb ]]; then
            error "Espace disque insuffisant : ${available_gb}GB disponibles, ${required_gb}GB requis"
            exit 1
        fi
        ok "Espace disque suffisant: ${available_gb}GB"
    fi
}

download_with_retry() {
    local url=$1
    local output=$2
    local max_retries=3
    local retry=0
    
    while [[ $retry -lt $max_retries ]]; do
        if curl -fsSL --retry 3 --retry-delay 2 --max-time 30 "$url" -o "$output" 2>/dev/null; then
            return 0
        fi
        retry=$((retry + 1))
        warn "Téléchargement échoué, tentative $retry/$max_retries"
        sleep 5
    done
    return 1
}

usage() {
    cat <<EOF
Usage : $0 [--i | --u] [--no-retropie | --retropie]

  --i             installation sans menu
  --u             desinstallation sans menu
  --no-retropie   ne pas installer RetroPie (avec --u : ne pas le desinstaller)
  --retropie      installer RetroPie sans poser la question (avec --u : le desinstaller)
  -h, --help      cette aide

Equivalent : XE_RETROPIE=yes|no
Via curl    : curl -fsSL <url>/install.sh | bash -s -- --i --no-retropie
Pendant l'installation de RetroPie, Ctrl+C passe cette etape sans arreter le reste.
EOF
}

# ask_yn "question" y|n  -> code 0 = oui, 1 = non (defaut si pas de terminal)
ask_yn() {
    local prompt=$1 def=${2:-n} ans hint
    [[ "$def" == "y" ]] && hint="Y/n" || hint="y/N"
    # Pas de terminal (cron, CI...) : on prend la valeur par defaut sans bruit
    if ! { true </dev/tty; } 2>/dev/null; then
        [[ "$def" == "y" ]]; return
    fi
    while true; do
        read -rp "  $prompt ($hint) : " ans </dev/tty || { [[ "$def" == "y" ]]; return; }
        case "${ans:-$def}" in
            y|Y|o|O) return 0 ;;
            n|N)     return 1 ;;
            *) echo "  Tapez 'y' ou 'n'." ;;
        esac
    done
}

detect_state() {
    HAS_RETROPIE=0
    HAS_JELLYFIN=0
    HAS_X=0
    HAS_NODE=0
    HAS_TAILSCALE=0
    HAS_REPO=0
    HAS_AUTOLOGIN=0

    command -v emulationstation >/dev/null 2>&1 && HAS_RETROPIE=1
    flatpak info "$JELLYFIN_APP_ID" >/dev/null 2>&1 && HAS_JELLYFIN=1
    command -v startx >/dev/null 2>&1 && HAS_X=1
    command -v node >/dev/null 2>&1 && {
        local v; v=$(node -v | cut -dv -f2 | cut -d. -f1)
        [[ $v -ge 20 ]] && HAS_NODE=1
    }
    command -v tailscale >/dev/null 2>&1 && HAS_TAILSCALE=1
    [[ -d "$INSTALL_DIR" ]] && HAS_REPO=1
    grep -q "XeLauncher" "$HOME/.bash_profile" 2>/dev/null && HAS_AUTOLOGIN=1

    ANYTHING_INSTALLED=0
    [[ $HAS_RETROPIE -eq 1 || $HAS_JELLYFIN -eq 1 || $HAS_X -eq 1 \
       || $HAS_REPO -eq 1 || $HAS_AUTOLOGIN -eq 1 ]] && ANYTHING_INSTALLED=1
}

print_state() {
    echo ""
    echo -e "${WHITE}Etat actuel du systeme :${RESET}"
    local check_yes="${GREEN}✔${RESET}"
    local check_no="${RED}✖${RESET}"

    [[ $HAS_NODE -eq 1 ]]      && echo -e "  $check_yes Node.js 20+"        || echo -e "  $check_no Node.js 20+"
    [[ $HAS_TAILSCALE -eq 1 ]] && echo -e "  $check_yes Tailscale"          || echo -e "  $check_no Tailscale"
    [[ $HAS_JELLYFIN -eq 1 ]]  && echo -e "  $check_yes Jellyfin (flatpak)" || echo -e "  $check_no Jellyfin (flatpak)"
    [[ $HAS_X -eq 1 ]]         && echo -e "  $check_yes Serveur X (xinit)"  || echo -e "  $check_no Serveur X (xinit)"
    [[ $HAS_REPO -eq 1 ]]      && echo -e "  $check_yes Depot XeLauncher"   || echo -e "  $check_no Depot XeLauncher"
    [[ $HAS_RETROPIE -eq 1 ]]  && echo -e "  $check_yes RetroPie"           || echo -e "  $check_no RetroPie"
    [[ $HAS_AUTOLOGIN -eq 1 ]] && echo -e "  $check_yes Autologin TTY1"     || echo -e "  $check_no Autologin TTY1"
    echo ""
}

# Decide si RetroPie sera installe. Appele AVANT la redirection des logs
# (sinon la question n'apparait pas a l'ecran).
decide_retropie() {
    INSTALL_RETROPIE=1
    case "$RETROPIE_CHOICE" in
        no)  INSTALL_RETROPIE=0 ;;
        yes) INSTALL_RETROPIE=1 ;;
        *)
            if [[ -z "$AUTO_MODE" && $HAS_RETROPIE -eq 0 ]]; then
                ask_yn "Installer RetroPie (20-60 min) ?" y || INSTALL_RETROPIE=0
            fi
            ;;
    esac
}

# Desinstallation : RetroPie et surtout ~/RetroPie (ROMs) ne partent que si on le demande.
decide_uninstall_retropie() {
    REMOVE_RETROPIE=0
    REMOVE_ROMS=0
    case "$RETROPIE_CHOICE" in
        yes) REMOVE_RETROPIE=1 ;;
        no)  REMOVE_RETROPIE=0 ;;
        *)
            if [[ $HAS_RETROPIE -eq 1 || -d "$HOME/RetroPie-Setup" ]]; then
                ask_yn "Desinstaller aussi RetroPie ?" n && REMOVE_RETROPIE=1
            fi
            ;;
    esac
    if [[ $REMOVE_RETROPIE -eq 1 && -d "$HOME/RetroPie" ]]; then
        ask_yn "Supprimer aussi ~/RetroPie (ROMs, BIOS, sauvegardes) ?" n && REMOVE_ROMS=1
    fi
}

interactive_menu() {
    if [[ -n "$AUTO_MODE" ]]; then
        MODE="$AUTO_MODE"
        detect_state

        echo -e "${WHITE}"
        echo "  +--------------------------------------------------+"
        echo "  |        XeLauncher — Prometheus Entertainment     |"
        echo "  |              Script d'installation               |"
        echo "  +--------------------------------------------------+"
        echo -e "${RESET}"
        print_state

        if [[ "$MODE" == "install" ]]; then
            decide_retropie
            echo -e "${YELLOW}⚠  Mode automatique :${RESET} Installation en cours..."
            [[ $INSTALL_RETROPIE -eq 0 ]] && echo "   RetroPie sera ignore."
        else
            decide_uninstall_retropie
            echo -e "${RED}⚠  Mode automatique :${RESET} Desinstallation en cours..."
        fi
        echo ""
        return 0
    fi

    clear
    echo -e "${WHITE}"
    echo "  +--------------------------------------------------+"
    echo "  |        XeLauncher — Prometheus Entertainment     |"
    echo "  |              Script d'installation               |"
    echo "  +--------------------------------------------------+"
    echo -e "${RESET}"

    detect_state
    print_state

    local choice=""

    if [[ $ANYTHING_INSTALLED -eq 0 ]]; then
        echo -e "  ${CYAN}[i]${RESET} Installer XeLauncher (RetroPie, Jellyfin, X, Node...)"
        echo -e "  ${RED}[q]${RESET} Quitter"
        echo ""
        while true; do
            read -rp "  Votre choix : " choice </dev/tty
            case "$choice" in
                i|I) MODE="install"; break ;;
                q|Q) echo "Annule."; exit 0 ;;
                *) echo "  Tapez 'i' pour installer, ou 'q' pour quitter." ;;
            esac
        done
    else
        echo -e "  ${CYAN}[i]${RESET} Installer ce qui manque & mettre a jour"
        echo -e "  ${RED}[u]${RESET} Desinstaller tout ce qu'XeLauncher a installe"
        echo -e "  ${YELLOW}[q]${RESET} Quitter"
        echo ""
        while true; do
            read -rp "  Votre choix : " choice </dev/tty
            case "$choice" in
                i|I) MODE="install"; break ;;
                u|U) MODE="uninstall"; break ;;
                q|Q) echo "Annule."; exit 0 ;;
                *) echo "  Tapez 'i', 'u' ou 'q'." ;;
            esac
        done
    fi

    echo ""

    if [[ "$MODE" == "install" ]]; then
        decide_retropie
        if [[ $INSTALL_RETROPIE -eq 1 ]]; then
            echo -e "${YELLOW}⚠  Attention :${RESET} L'installation peut durer ${WHITE}une heure ou plus${RESET},"
            echo    "   notamment a cause de RetroPie (Ctrl+C pendant RetroPie = passer cette etape)."
        else
            echo -e "${YELLOW}⚠  Attention :${RESET} L'installation peut prendre un moment. RetroPie sera ignore."
        fi
        echo    "   Assurez-vous que le systeme reste allume et connecte a Internet."
    else
        decide_uninstall_retropie
        echo -e "${RED}⚠  Desinstallation :${RESET} Tout ce qu'XeLauncher a installe sera supprime"
        if [[ $REMOVE_RETROPIE -eq 1 ]]; then
            echo    "   (RetroPie inclus$([[ $REMOVE_ROMS -eq 1 ]] && echo ', ROMs comprises'))."
        else
            echo    "   (RetroPie conserve)."
        fi
    fi

    echo ""
    local confirm=""
    while true; do
        read -rp "  Confirmer ? (y/N) : " confirm </dev/tty
        case "$confirm" in
            y|Y) break ;;
            ""|n|N) echo "Annule."; exit 0 ;;
            *) echo "  Tapez 'y' pour confirmer ou 'n' pour annuler." ;;
        esac
    done
    echo ""
}

check_and_install_packages() {
    local to_install=() pkg
    for pkg in "$@"; do
        if ! dpkg -s "$pkg" 2>/dev/null | grep -q "^Status: install ok installed"; then
            to_install+=("$pkg")
        fi
    done
    [[ ${#to_install[@]} -eq 0 ]] && return 0

    log "Installation des paquets manquants: ${to_install[*]}"
    if sudo apt-get install -y "${to_install[@]}"; then
        done_action "Paquets systeme installes : ${to_install[*]}"
        return 0
    fi

    # Un seul nom de paquet inconnu (ex. renommage t64 sur Debian 13) fait echouer
    # tout le lot : on reessaie un par un et on continue.
    warn "Installation groupee echouee, nouvel essai paquet par paquet"
    local good=() bad=()
    for pkg in "${to_install[@]}"; do
        if sudo apt-get install -y "$pkg"; then good+=("$pkg"); else bad+=("$pkg"); fi
    done
    [[ ${#good[@]} -gt 0 ]] && done_action "Paquets systeme installes : ${good[*]}"
    if [[ ${#bad[@]} -gt 0 ]]; then
        warn "Paquets NON installes : ${bad[*]}"
        fail_action "Paquets non installes : ${bad[*]}"
    fi
    return 0
}

install_nodejs() {
    if [[ $HAS_NODE -eq 1 ]]; then
        ok "Node.js $(node -v) deja installe"
        return 0
    fi
    log "Installation de Node.js 20.x"
    download_with_retry "https://deb.nodesource.com/setup_20.x" "/tmp/node_setup.sh" \
        || { error "Impossible de telecharger le script NodeSource"; exit 1; }
    sudo bash /tmp/node_setup.sh
    rm -f /tmp/node_setup.sh
    sudo apt-get install -y nodejs \
        || { error "Echec installation nodejs"; exit 1; }
    ok "Node.js installe : $(node -v)"
    done_action "Node.js $(node -v) installe"
}

install_tailscale() {
    if [[ $HAS_TAILSCALE -eq 1 ]]; then
        ok "Tailscale deja installe"
        return 0
    fi
    log "Installation de Tailscale"
    download_with_retry "https://tailscale.com/install.sh" "/tmp/tailscale_install.sh" \
        || { error "Impossible de telecharger le script Tailscale"; exit 1; }
    sudo bash /tmp/tailscale_install.sh
    rm -f /tmp/tailscale_install.sh
    sudo systemctl enable --now tailscaled 2>/dev/null || true
    ok "Tailscale installe"
    done_action "Tailscale installe et demarre"
}

install_flatpak_jellyfin() {
    if ! command -v flatpak >/dev/null 2>&1; then
        sudo apt-get install -y flatpak \
            || { error "Echec installation flatpak"; exit 1; }
        done_action "Flatpak installe"
    fi

    sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo

    if [[ $HAS_JELLYFIN -eq 0 ]]; then
        log "Installation de Jellyfin Media Player"
        sudo flatpak install -y flathub "$JELLYFIN_APP_ID" \
            2>&1 | grep -v $'^\033' | tee -a "$LOG_FILE" || \
            { error "Echec installation Jellyfin"; exit 1; }
        ok "Jellyfin Media Player installe"
        done_action "Jellyfin Media Player installe via flatpak"
    else
        log "Mise a jour de Jellyfin Media Player"
        sudo flatpak update -y "$JELLYFIN_APP_ID" 2>/dev/null \
            && done_action "Jellyfin Media Player mis a jour" || true
        ok "Jellyfin a jour"
    fi

    log "Configuration des permissions flatpak"
    if ! getent group flatpak >/dev/null 2>&1; then
        sudo groupadd flatpak
    fi
    if ! groups "$REAL_USER" | grep -q '\bflatpak\b'; then
        sudo usermod -a -G flatpak "$REAL_USER"
    fi
    flatpak override --user --socket=x11 --share=network \
        "$JELLYFIN_APP_ID" 2>/dev/null || true
    if flatpak info "$JELLYFIN_OLD_APP_ID" >/dev/null 2>&1; then
        warn "Ancien Jellyfin Media Player detecte : XeLauncher utilise $JELLYFIN_APP_ID"
        warn "  (le retirer : sudo flatpak uninstall $JELLYFIN_OLD_APP_ID)"
    fi
    ok "Flatpak et Jellyfin configures"
}

clone_or_update_repo() {
    if [[ ! -d "$INSTALL_DIR" ]]; then
        log "Clonage du depot XeLauncher"
        git clone "$REPO_URL" "$INSTALL_DIR" \
            || { error "Echec du clonage du depot"; exit 1; }
        ok "Depot clone"
        done_action "Depot XeLauncher clone dans $INSTALL_DIR"
    else
        log "Mise a jour du depot"
        cd "$INSTALL_DIR"
        git stash push -m "auto-stash" 2>/dev/null || true
        git pull --rebase \
            || { error "Echec de la mise a jour du depot"; exit 1; }
        ok "Depot mis a jour"
        done_action "Depot XeLauncher mis a jour"
    fi
}

fix_package_json() {
    cd "$INSTALL_DIR"
    local changed=0

    if [[ ! -f "package.json" ]]; then
        log "Creation de package.json"
        cat > package.json <<'EOF'
{
  "name": "xelauncher",
  "version": "1.0.0",
  "main": "src/JSs/main.js",
  "scripts": {
    "start": "electron ."
  },
  "dependencies": {
    "electron": "^28.0.0"
  },
  "devDependencies": {
    "electron-reload": "^1.5.0"
  },
  "author": "Xelopteryx"
}
EOF
        changed=1
    else
        if grep -q '"main": "src/main.js"' package.json 2>/dev/null; then
            sed -i 's|"main": "src/main.js"|"main": "src/JSs/main.js"|' package.json
            changed=1
        fi
        if grep -q '"electron-reload": "\\^2\\.0\\.0"' package.json 2>/dev/null; then
            sed -i 's/"electron-reload": "\\^2\\.0\\.0"/"electron-reload": "^1.5.0"/' package.json
            changed=1
        fi
    fi

    [[ $changed -eq 1 ]] && done_action "package.json cree/corrige (main: src/JSs/main.js)"
}

install_npm_deps() {
    cd "$INSTALL_DIR"
    fix_package_json

    local needs_install=0
    if [[ ! -d "node_modules" ]]; then
        needs_install=1
    else
        local pkg_hash lock_hash
        pkg_hash=$(md5sum package.json 2>/dev/null | cut -d' ' -f1) || pkg_hash=""
        lock_hash=$(cat "node_modules/.pkg.hash" 2>/dev/null) || lock_hash=""
        [[ "$pkg_hash" != "$lock_hash" ]] && needs_install=1
    fi

    if [[ $needs_install -eq 0 ]]; then
        ok "Dependances npm deja a jour"
        return 0
    fi

    log "Installation des dependances npm"
    npm install || { error "Echec npm install"; exit 1; }
    md5sum package.json 2>/dev/null | cut -d' ' -f1 > node_modules/.pkg.hash || true
    ok "Dependances npm installees"
    done_action "Dependances npm installees"
}

install_retropie() {
    if [[ $INSTALL_RETROPIE -eq 0 ]]; then
        warn "RetroPie ignore (--no-retropie ou choix a l'invite)"
        return 0
    fi

    if [[ $HAS_RETROPIE -eq 1 ]]; then
        ok "RetroPie deja installe"
        return 0
    fi

    if [[ "$PLATFORM" == "rpi5" ]]; then
        log "Installation de RetroPie sur Raspberry Pi 5 (optimisee)"
        # /boot/config.txt n'existe plus sur Raspberry Pi OS recent : c'est /boot/firmware/config.txt
        local boot_cfg="" candidate
        for candidate in /boot/firmware/config.txt /boot/config.txt; do
            [[ -f "$candidate" ]] && { boot_cfg="$candidate"; break; }
        done
        if [[ -n "$boot_cfg" ]] && ! grep -qE '^[[:space:]]*dtoverlay=vc4-kms-v3d' "$boot_cfg"; then
            echo "dtoverlay=vc4-kms-v3d" | sudo tee -a "$boot_cfg" >/dev/null
            log "Configuration GPU ajoutee dans $boot_cfg (redemarrage requis plus tard)"
            done_action "dtoverlay=vc4-kms-v3d ajoute dans $boot_cfg"
        fi
    else
        log "Installation de RetroPie (20-40 minutes)"
    fi

    if [[ ! -d "$HOME/RetroPie-Setup" ]]; then
        git clone --depth=1 https://github.com/RetroPie/RetroPie-Setup.git "$HOME/RetroPie-Setup" \
            || { warn "Echec clonage RetroPie-Setup : RetroPie ignore"
                 fail_action "RetroPie : clonage de RetroPie-Setup echoue"
                 return 0; }
    fi

    cd "$HOME/RetroPie-Setup" \
        || { warn "RetroPie-Setup inaccessible : RetroPie ignore"
             fail_action "RetroPie : dossier RetroPie-Setup inaccessible"
             return 0; }
    git pull --rebase 2>/dev/null || true

    log "Lancement de l'installation RetroPie... (Ctrl+C = passer cette etape, le reste continue)"
    RETROPIE_INTERRUPTED=0
    trap 'RETROPIE_INTERRUPTED=1' INT
    sudo __nodialog=1 ./retropie_packages.sh setup basic_install
    local rc=$?
    trap - INT
    cd "$HOME" || true

    if [[ $RETROPIE_INTERRUPTED -eq 1 ]]; then
        warn "RetroPie interrompu (Ctrl+C) : etape ignoree, le reste de l'installation continue"
        fail_action "RetroPie : installation interrompue (relancer l'installateur pour reprendre)"
        return 0
    fi
    if [[ $rc -ne 0 ]]; then
        warn "Echec installation RetroPie (code $rc), voir $LOG_FILE : le reste continue"
        fail_action "RetroPie : installation echouee (code $rc)"
        return 0
    fi

    mkdir -p "$HOME/RetroPie/roms"/{nes,snes,gb,gba,n64,psx,mame,arcade}

    if command -v emulationstation >/dev/null 2>&1; then
        ok "RetroPie installe avec succes"
        done_action "RetroPie installe (basic_install)"
    else
        warn "RetroPie n'a pas pu etre confirme. Verifiez $LOG_FILE"
        fail_action "RetroPie : emulationstation introuvable apres installation"
    fi
}

configure_retropie_menu() {
    local cfg="/etc/emulationstation/es_systems.cfg"
    if [[ $INSTALL_RETROPIE -eq 0 && $HAS_RETROPIE -eq 0 ]]; then
        return 0    # RetroPie ignore : rien a configurer
    fi
    if [[ ! -f "$cfg" ]]; then
        warn "es_systems.cfg introuvable — configuration RetroPie menu ignoree"
        return 0
    fi

    # Vérifier si la modification est déjà en place
    if grep -q "xterm.*retropiemenu" "$cfg" 2>/dev/null; then
        ok "es_systems.cfg deja configure (xterm)"
        return 0
    fi

    log "Configuration du menu RetroPie pour fonctionner sous X11 (xterm)"
    sudo sed -i \
        's|<command>sudo \(.*\)retropie_packages\.sh retropiemenu launch %ROM%.*</command>|<command>xterm -fullscreen -e sudo \1retropie_packages.sh retropiemenu launch %ROM%</command>|' \
        "$cfg" \
        && ok "es_systems.cfg mis a jour (xterm -fullscreen)" \
        && done_action "es_systems.cfg: menu RetroPie lance dans xterm -fullscreen" \
        || warn "Echec modification es_systems.cfg — a faire manuellement"
}

# Boot silencieux : ligne de commande noyau.
#  - quiet splash plymouth.ignore-serial-consoles : Plymouth actif, pas de texte
#  - logo.nologo vt.global_cursor_default=0 loglevel=3 : pas de logos/curseur/messages
#  - console=tty1 -> console=tty3 : le texte du noyau va sur un AUTRE terminal (Ctrl+Alt+F3)
# $1 = cmdline.txt. Sauvegarde <fichier>.xelauncher.bak au premier passage.
# Code retour : 0 = modifie, 1 = deja a jour.
cmdline_apply() {
    local file=$1 line tok new cur
    local -a old out
    line=$(head -n1 "$file")
    read -ra old <<<"$line"
    out=()
    for tok in "${old[@]}"; do
        case "$tok" in
            plymouth.enable=0|loglevel=*|vt.global_cursor_default=*) ;;   # re-poses ci-dessous
            console=tty1) out+=("console=tty3") ;;
            *) out+=("$tok") ;;
        esac
    done
    for tok in quiet splash plymouth.ignore-serial-consoles logo.nologo loglevel=3 vt.global_cursor_default=0; do
        [[ " ${out[*]} " == *" $tok "* ]] || out+=("$tok")
    done
    new="${out[*]}"
    cur="${old[*]}"
    [[ "$new" == "$cur" ]] && return 1
    [[ -f "$file.xelauncher.bak" ]] || sudo cp -a "$file" "$file.xelauncher.bak"
    echo "$new" | sudo tee "$file" >/dev/null
    return 0
}

# config.txt (Raspberry Pi) : pas d'ecran arc-en-ciel, initramfs charge par le firmware
# (necessaire pour que Plymouth demarre tot). Bloc delimite => retirable proprement.
apply_boot_config_txt() {
    local cfg="" c block
    for c in /boot/firmware/config.txt /boot/config.txt; do
        [[ -f "$c" ]] && { cfg="$c"; break; }
    done
    [[ -n "$cfg" ]] || return 0
    grep -qF "$BOOT_MARK_BEGIN" "$cfg" && return 0
    block="$BOOT_MARK_BEGIN"$'\n'"[all]"$'\n'"disable_splash=1"
    if ! grep -qE '^[[:space:]]*(auto_initramfs=1|initramfs[[:space:]])' "$cfg"; then
        block+=$'\n'"auto_initramfs=1"
    fi
    block+=$'\n'"$BOOT_MARK_END"
    [[ -f "$cfg.xelauncher.bak" ]] || sudo cp -a "$cfg" "$cfg.xelauncher.bak"
    printf '\n%s\n' "$block" | sudo tee -a "$cfg" >/dev/null
    ok "$cfg : disable_splash=1 (+ auto_initramfs si absent)"
    done_action "$cfg mis a jour (bloc XeLauncher boot)"
}

# Verifie que le theme est bien dans l'initramfs (sinon pas de logo au boot).
verify_plymouth_initramfs() {
    command -v lsinitramfs >/dev/null 2>&1 || return 0
    local img n checked=0
    for img in "/boot/initrd.img-$(uname -r)" /boot/firmware/initramfs_2712 /boot/firmware/initramfs8; do
        [[ -f "$img" ]] || continue
        checked=1
        n=$(lsinitramfs "$img" 2>/dev/null | grep -c 'xe_theme' || true)
        if [[ "${n:-0}" -gt 0 ]]; then
            ok "Theme xe_theme present dans $(basename "$img")"
        else
            warn "Theme xe_theme ABSENT de $img : pas de logo au boot"
            fail_action "Plymouth : theme absent de l'initramfs ($img)"
        fi
    done
    if [[ $checked -eq 0 ]]; then
        warn "Aucun initramfs trouve (update-initramfs a-t-il echoue ?) : le logo risque de ne pas apparaitre"
        fail_action "Plymouth : aucun initramfs trouve"
    fi
}

configure_boot_splash() {
    local logo="$INSTALL_DIR/src/LOGOs/prometheus.png"
    local theme_src="$INSTALL_DIR/src/plymouth/xe_theme"

    if [[ ! -f "$logo" ]]; then
        warn "Logo introuvable a $logo — thème Plymouth ignore"
        return 0
    fi
    if [[ ! -f "$theme_src/xe_theme.plymouth" || ! -f "$theme_src/xe_theme.script" ]]; then
        warn "Thème Plymouth introuvable dans $theme_src — ignore (verifiez le depot)"
        return 0
    fi

    # -- Installation du thème xe_theme --
    sudo mkdir -p "$PLYMOUTH_THEME_DIR"
    sudo cp "$theme_src/xe_theme.plymouth" "$theme_src/xe_theme.script" "$PLYMOUTH_THEME_DIR/"
    sudo cp "$logo" "$PLYMOUTH_THEME_DIR/prometheus.png"

    local current_theme
    current_theme=$(plymouth-set-default-theme 2>/dev/null || true)
    if [[ "$current_theme" != "xe_theme" ]]; then
        sudo plymouth-set-default-theme xe_theme
        ok "Theme Plymouth xe_theme active"
        done_action "Theme Plymouth xe_theme installe et defini par defaut"
    else
        ok "Theme Plymouth xe_theme deja actif (fichiers resynchronises)"
    fi

    # -- Boot silencieux : parametres noyau --
    local cmdline="/boot/firmware/cmdline.txt"
    [[ -f "$cmdline" ]] || cmdline="/boot/cmdline.txt"
    if [[ -f "$cmdline" ]]; then
        if cmdline_apply "$cmdline"; then
            ok "$cmdline mis a jour (boot silencieux, texte noyau sur tty3)"
            done_action "$cmdline : quiet splash logo.nologo loglevel=3 console=tty3 (sauvegarde .xelauncher.bak)"
        else
            ok "$cmdline deja a jour"
        fi
    else
        warn "cmdline.txt introuvable : boot silencieux non configure (parametres noyau a ajouter a la main)"
        fail_action "cmdline.txt introuvable : ajouter 'quiet splash console=tty3' a la main"
    fi

    case "$PLATFORM" in
        rpi*) apply_boot_config_txt ;;
    esac

    # -- Plymouth reste affiche jusqu'a ce qu'Electron appelle 'plymouth quit' (main-window.js) --
    # Sans ca, systemd le coupe des le demarrage du getty et le texte de login apparait.
    # Le .bash_profile fait 'plymouth deactivate' avant startx pour liberer le DRM.
    if command -v plymouth >/dev/null 2>&1; then
        sudo systemctl mask plymouth-quit.service plymouth-quit-wait.service >/dev/null 2>&1 || true
        ok "plymouth-quit masque : le splash reste jusqu'a l'affichage d'Electron"
        done_action "plymouth-quit(.service/-wait.service) masques"
    fi

    # -- Reconstruire l'initramfs APRES tout le reste (theme + plymouth-label) --
    if command -v update-initramfs >/dev/null 2>&1; then
        log "Regeneration de l'initramfs (embarque le theme Plymouth)..."
        if sudo update-initramfs -u; then
            done_action "initramfs regenere (theme Plymouth embarque)"
        else
            warn "update-initramfs a echoue : le theme ne sera pas dans l'initramfs"
            fail_action "Plymouth : update-initramfs a echoue"
        fi
    fi
    verify_plymouth_initramfs

    # -- Desactiver le splashscreen propre a RetroPie (asplashscreen) --
    # pour eviter qu'il ne s'affiche par-dessus / apres celui de Plymouth.
    if systemctl list-unit-files 2>/dev/null | grep -q '^asplashscreen\.service'; then
        if systemctl is-enabled asplashscreen >/dev/null 2>&1; then
            sudo systemctl disable asplashscreen 2>/dev/null || true
            ok "Splashscreen RetroPie (asplashscreen) desactive"
            done_action "asplashscreen.service (splash RetroPie) desactive au profit de Plymouth"
        else
            ok "Splashscreen RetroPie deja desactive"
        fi
    fi
    sudo rm -f /etc/splashscreen.list
}

create_start_script() {
    # start.sh et xelauncher.sh sont desormais versionnes dans le depot
    # (avec DBUS_SESSION_BUS_ADDRESS, XAUTHORITY, xdg-desktop-portal-gtk,
    # logs/ consolides, etc.) : on ne les regenere plus ici, on se
    # contente de les rendre executables pour ne pas ecraser le travail
    # fait dans le repo avec un vieux template.
    for f in "$INSTALL_DIR/start.sh" "$INSTALL_DIR/xelauncher.sh"; do
        if [[ -f "$f" ]]; then
            chmod +x "$f"
            ok "$(basename "$f") rendu executable (fourni par le depot)"
        else
            warn "$(basename "$f") introuvable dans le depot — verifiez le clonage"
        fi
    done

    cat > "$HOME/.xinitrc" <<EOF
#!/bin/bash
xset s off
xset -dpms
xset s noblank
openbox &

# Neutralise le curseur souris de façon permanente (XFixesHideCursor).
# (ignore si le script n'est pas present dans le depot)
if [ -f "$INSTALL_DIR/scripts/xe_cursor_pin.py" ]; then
    python3 "$INSTALL_DIR/scripts/xe_cursor_pin.py" &
fi

exec "$INSTALL_DIR/xelauncher.sh"
EOF
    chmod +x "$HOME/.xinitrc"
    ok "Fichier .xinitrc cree (openbox + xelauncher.sh ; xe_cursor_pin.py si present)"
    done_action "~/.xinitrc cree ; start.sh/xelauncher.sh du depot rendus executables"
}

xe_profile_block() {
    cat <<'EOF'
# Lancement de XeLauncher (Prometheus Entertainment System)
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
    # Libere le DRM pour X en gardant le splash a l'ecran (Electron fera 'plymouth quit')
    sudo -n /usr/bin/plymouth deactivate >/dev/null 2>&1 || sudo -n /usr/bin/plymouth quit >/dev/null 2>&1
    exec startx "$HOME/.xinitrc" -- :0 vt1 -nolisten tcp >"$HOME/.xelauncher-startx.log" 2>&1
fi
EOF
}

configure_autologin() {
    if command -v raspi-config >/dev/null 2>&1; then
        log "Configuration de l'autologin console via raspi-config"
        sudo raspi-config nonint do_boot_behaviour B2
        ok "Autologin console configure"
        done_action "Autologin TTY1 configure via raspi-config"
    fi

    # Autologin silencieux (pas de /etc/issue, pas d'effacement d'ecran). Ecrit dans tous les cas :
    # override.conf passe apres l'autologin.conf de raspi-config et prend le dessus.
    log "Autologin silencieux sur TTY1"
    sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
    cat <<EOF | sudo tee "$GETTY_OVERRIDE" >/dev/null
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $REAL_USER --noclear --noissue %I \$TERM
EOF
    sudo systemctl daemon-reload
    ok "Autologin TTY1 silencieux configure"
    done_action "Autologin TTY1 silencieux (systemd, $GETTY_OVERRIDE)"

    # Supprime "Last login" / motd a l'ouverture de session
    touch "$HOME/.hushlogin"

    local BASH_PROFILE="$HOME/.bash_profile"

    if ! grep -q "XeLauncher" "$BASH_PROFILE" 2>/dev/null; then
        if ! grep -q '\.bashrc' "$BASH_PROFILE" 2>/dev/null; then
            echo '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"' >> "$BASH_PROFILE"
        fi
        { echo ""; xe_profile_block; } >> "$BASH_PROFILE"
        ok "XeLauncher ajoute au demarrage dans .bash_profile"
        done_action "~/.bash_profile configure (startx sur TTY1, sans texte)"
    elif grep -q "plymouth deactivate" "$BASH_PROFILE" 2>/dev/null; then
        ok "XeLauncher deja correctement configure dans .bash_profile"
    else
        # Ancien bloc (avec echo "Demarrage..." et sans handoff Plymouth) : on le remplace
        sed -i '/# Lancement de XeLauncher/,/^fi$/d' "$BASH_PROFILE"
        { echo ""; xe_profile_block; } >> "$BASH_PROFILE"
        ok ".bash_profile mis a jour (demarrage silencieux + handoff Plymouth)"
        done_action "~/.bash_profile corrige (silencieux + plymouth deactivate)"
    fi

    if grep -q "XeLauncher" "$HOME/.profile" 2>/dev/null; then
        sed -i '/# Lancement de XeLauncher/,/^fi$/d' "$HOME/.profile"
        done_action "~/.profile nettoye (doublon supprime)"
    fi
}

configure_systemd_service() {
    if systemctl is-enabled xelauncher 2>/dev/null | grep -q "enabled"; then
        sudo systemctl disable xelauncher 2>/dev/null || true
        sudo systemctl stop xelauncher 2>/dev/null || true
        sudo rm -f /etc/systemd/system/xelauncher.service
        sudo systemctl daemon-reload
    fi

    sudo tee /etc/systemd/system/xelauncher.service > /dev/null <<EOF
[Unit]
Description=XeLauncher Kiosk (fallback)
After=systemd-user-sessions.service

[Service]
Type=simple
User=$REAL_USER
Group=$REAL_USER
PAMName=login
TTYPath=/dev/tty1
StandardInput=tty
StandardOutput=journal
StandardError=journal
Environment=HOME=/home/$REAL_USER
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u "$REAL_USER")
ExecStart=/usr/bin/startx /home/$REAL_USER/.xinitrc -- :0 vt1 -nolisten tcp
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    ok "Service systemd de fallback cree (non active)"
    done_action "Service systemd xelauncher.service cree (fallback, non active)"
}

configure_sudoers() {
    # Commandes lancees par l'interface (src/JSs/*.js) sans terminal :
    #   ipc-system.js  : systemctl reboot/poweroff, apt update / apt-get update+upgrade
    #   ipc-jellyfin.js: systemctl start tailscaled, tailscale up
    #   main-window.js : plymouth --update=fade, plymouth quit
    #   .bash_profile  : plymouth deactivate (avant startx)
    # SETENV est necessaire car le JS ecrit "sudo DEBIAN_FRONTEND=noninteractive apt-get ...".
    local tmp
    tmp=$(mktemp) || { warn "mktemp a echoue : sudoers non configure"; return 0; }
    cat > "$tmp" <<EOF
# XeLauncher : commandes lancees par l'interface sans mot de passe
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/bin/systemctl start tailscaled, /usr/bin/tailscale up, /usr/bin/plymouth --update=fade, /usr/bin/plymouth quit, /usr/bin/plymouth deactivate, SETENV: /usr/bin/apt-get update -qq, /usr/bin/apt-get upgrade -y -qq, /usr/bin/apt update -qq
EOF
    # Un sudoers invalide peut casser sudo : on valide avant d'installer.
    if command -v visudo >/dev/null 2>&1 && ! sudo visudo -cf "$tmp" >/dev/null 2>&1; then
        rm -f "$tmp"
        warn "Regles sudoers invalides (visudo) : non installees"
        fail_action "sudoers : regles rejetees par visudo, non installees"
        return 0
    fi
    sudo install -m 440 -o root -g root "$tmp" "$SUDOERS_FILE"
    rm -f "$tmp"
    ok "Regles sudoers configurees"
    done_action "Regles sudoers configurees ($SUDOERS_FILE)"
}

configure_input_system() {
    local changed=0

    # xe_input.py lit /dev/input/event* directement : l'utilisateur doit
    # appartenir aux groupes input et bluetooth pour y acceder sans root.
    for grp in input bluetooth; do
        if ! getent group "$grp" >/dev/null 2>&1; then
            sudo groupadd "$grp" 2>/dev/null || true
        fi
        if ! groups "$REAL_USER" | grep -q "\b${grp}\b"; then
            sudo usermod -a -G "$grp" "$REAL_USER"
            changed=1
        fi
    done

    # Regle udev garantissant group=input, mode=0660 sur tous les
    # /dev/input/event* — necessaire car sans elle, l'acces depend de
    # la session logind (uaccess) qui n'existe pas forcement sur un
    # autologin TTY1 sans seat graphique complet.
    local udev_rule="/etc/udev/rules.d/99-xelauncher-input.rules"
    local udev_content='SUBSYSTEM=="input", GROUP="input", MODE="0660"'
    if [[ ! -f "$udev_rule" ]] || ! grep -qF "$udev_content" "$udev_rule" 2>/dev/null; then
        echo "$udev_content" | sudo tee "$udev_rule" >/dev/null
        sudo udevadm control --reload-rules
        sudo udevadm trigger --subsystem-match=input
        changed=1
    fi

    # Support Wiimote (hid-wiimote) : module a charger au boot
    local modules_file="/etc/modules-load.d/xelauncher.conf"
    if [[ ! -f "$modules_file" ]] || ! grep -q "^hid-wiimote$" "$modules_file" 2>/dev/null; then
        echo "hid-wiimote" | sudo tee -a "$modules_file" >/dev/null
        sudo modprobe hid-wiimote 2>/dev/null || warn "hid-wiimote non charge (module absent ou deja charge)"
        changed=1
    fi

    if [[ $changed -eq 1 ]]; then
        ok "Systeme d'entree configure (groupes input/bluetooth, regle udev, module hid-wiimote)"
        done_action "Groupes input/bluetooth + regle udev 99-xelauncher-input.rules + module hid-wiimote configures"
        warn "Une deconnexion/redemarrage est necessaire pour que les groupes soient effectifs"
    else
        ok "Systeme d'entree deja configure"
    fi
}

create_required_dirs() {
    mkdir -p \
        "$INSTALL_DIR/src/AVATARs" \
        "$INSTALL_DIR/src/LOGOs" \
        "$INSTALL_DIR/src/HTMLs" \
        "$INSTALL_DIR/src/JSs" \
        "$INSTALL_DIR/src/CSSs" \
        "$INSTALL_DIR/src/FONTs" \
        "$INSTALL_DIR/src/plymouth" \
        "$INSTALL_DIR/logs"
    ok "Dossiers src/ et logs/ crees"
    done_action "Dossiers src/ et logs/ crees/verifies"
}

uninstall_all() {
    section "Desinstallation de XeLauncher"

    local anything_done=0

    if [[ -d "$INSTALL_DIR" ]]; then
        log "Suppression du depot $INSTALL_DIR"
        rm -rf "$INSTALL_DIR"
        ok "Depot supprime"
        done_action "Depot $INSTALL_DIR supprime"
        anything_done=1
    fi

    if [[ -f "$HOME/.xinitrc" ]]; then
        rm -f "$HOME/.xinitrc"
        ok "~/.xinitrc supprime"
        done_action "~/.xinitrc supprime"
        anything_done=1
    fi

    if grep -q "XeLauncher" "$HOME/.bash_profile" 2>/dev/null; then
        sed -i '/# Lancement de XeLauncher/,/^fi$/d' "$HOME/.bash_profile"
        ok ".bash_profile nettoye"
        done_action "~/.bash_profile nettoye"
        anything_done=1
    fi

    if grep -q "XeLauncher" "$HOME/.profile" 2>/dev/null; then
        sed -i '/# Lancement de XeLauncher/,/^fi$/d' "$HOME/.profile"
        done_action "~/.profile nettoye"
        anything_done=1
    fi

    if [[ -f "/etc/systemd/system/xelauncher.service" ]]; then
        sudo systemctl disable xelauncher 2>/dev/null || true
        sudo systemctl stop xelauncher 2>/dev/null || true
        sudo rm -f /etc/systemd/system/xelauncher.service
        sudo systemctl daemon-reload
        ok "Service systemd supprime"
        done_action "Service systemd xelauncher.service supprime"
        anything_done=1
    fi

    if [[ -f "$SUDOERS_FILE" ]]; then
        sudo rm -f "$SUDOERS_FILE"
        ok "Regles sudoers supprimees"
        done_action "Regles sudoers supprimees"
        anything_done=1
    fi

    log "Desinstallation de Jellyfin Media Player"
    sudo flatpak uninstall -y "$JELLYFIN_APP_ID" 2>/dev/null || true
    sudo flatpak uninstall -y "$JELLYFIN_OLD_APP_ID" 2>/dev/null || true
    sudo flatpak uninstall -y --unused 2>/dev/null || true
    ok "Jellyfin desinstalle"
    done_action "Jellyfin Media Player desinstalle"
    anything_done=1

    if [[ $REMOVE_RETROPIE -eq 1 ]]; then
        log "Desinstallation de RetroPie"
        if [[ -d "$HOME/RetroPie-Setup" ]]; then
            cd "$HOME/RetroPie-Setup" \
                && sudo __nodialog=1 ./retropie_packages.sh setup remove_all 2>/dev/null || true
            cd "$HOME" || true
        fi
        sudo rm -rf "$HOME/RetroPie-Setup"
        sudo rm -rf /opt/retropie
        sudo rm -f /usr/bin/emulationstation
        sudo apt-get remove -y emulationstation 2>/dev/null || true
        ok "RetroPie desinstalle"
        done_action "RetroPie desinstalle"
        if [[ $REMOVE_ROMS -eq 1 ]]; then
            sudo rm -rf "$HOME/RetroPie"
            ok "~/RetroPie (ROMs, BIOS, sauvegardes) supprime"
            done_action "~/RetroPie supprime"
        elif [[ -d "$HOME/RetroPie" ]]; then
            ok "~/RetroPie conserve (ROMs, BIOS, sauvegardes)"
        fi
        anything_done=1
    else
        log "RetroPie conserve"
    fi

    log "Desinstallation de Node.js"
    sudo apt-get remove -y nodejs 2>/dev/null || true
    sudo rm -f /etc/apt/sources.list.d/nodesource.list
    sudo rm -f /etc/apt/sources.list.d/nodesource.list.distUpgrade
    ok "Node.js desinstalle"
    done_action "Node.js desinstalle"
    anything_done=1

    log "Desinstallation de Tailscale"
    sudo systemctl stop tailscaled 2>/dev/null || true
    sudo systemctl disable tailscaled 2>/dev/null || true
    sudo apt-get remove -y tailscale 2>/dev/null || true
    sudo rm -f /etc/apt/sources.list.d/tailscale.list
    ok "Tailscale desinstalle"
    done_action "Tailscale desinstalle"
    anything_done=1

    log "Desinstallation de Xorg / xinit"
    sudo apt-get remove -y xserver-xorg xinit openbox xdotool 2>/dev/null || true
    sudo apt-get autoremove -y 2>/dev/null || true
    ok "Xorg desinstalle"
    done_action "Xorg / xinit / openbox desinstalle"
    anything_done=1

    if [[ -f "/etc/udev/rules.d/99-xelauncher-input.rules" ]]; then
        sudo rm -f "/etc/udev/rules.d/99-xelauncher-input.rules"
        sudo udevadm control --reload-rules 2>/dev/null || true
        ok "Regle udev input supprimee"
        done_action "/etc/udev/rules.d/99-xelauncher-input.rules supprimee"
        anything_done=1
    fi

    if [[ -f "/etc/modules-load.d/xelauncher.conf" ]]; then
        sudo rm -f "/etc/modules-load.d/xelauncher.conf"
        ok "Chargement hid-wiimote au boot supprime"
        done_action "/etc/modules-load.d/xelauncher.conf supprime"
        anything_done=1
    fi

    # -- Boot silencieux : retour a l'etat d'avant --
    if systemctl is-enabled plymouth-quit.service 2>/dev/null | grep -q masked; then
        sudo systemctl unmask plymouth-quit.service plymouth-quit-wait.service 2>/dev/null || true
        done_action "plymouth-quit demasque"
        anything_done=1
    fi
    for f in /boot/firmware/cmdline.txt /boot/cmdline.txt /boot/firmware/config.txt /boot/config.txt; do
        if [[ -f "$f.xelauncher.bak" ]]; then
            case "$f" in
                */cmdline.txt) sudo cp -a "$f.xelauncher.bak" "$f" ;;
                */config.txt)  sudo sed -i "/^# >>> XeLauncher boot >>>\$/,/^# <<< XeLauncher boot <<<\$/d" "$f" ;;
            esac
            sudo rm -f "$f.xelauncher.bak"
            done_action "$f remis comme avant XeLauncher"
            anything_done=1
        fi
    done
    if [[ -f "$GETTY_OVERRIDE" ]]; then
        sudo rm -f "$GETTY_OVERRIDE"
        sudo systemctl daemon-reload
        done_action "Autologin silencieux (getty override) supprime"
        anything_done=1
    fi
    rm -f "$HOME/.xelauncher-startx.log"

    if [[ -d "$PLYMOUTH_THEME_DIR" ]]; then
        current_theme=$(plymouth-set-default-theme 2>/dev/null || true)
        if [[ "$current_theme" == "xe_theme" ]]; then
            for fallback in pix debian text; do
                if plymouth-set-default-theme --list 2>/dev/null | grep -qx "$fallback"; then
                    sudo plymouth-set-default-theme "$fallback"
                    command -v update-initramfs >/dev/null 2>&1 && sudo update-initramfs -u
                    break
                fi
            done
        fi
        sudo rm -rf "$PLYMOUTH_THEME_DIR"
        ok "Theme Plymouth xe_theme supprime"
        done_action "Theme Plymouth xe_theme supprime"
        anything_done=1
    fi

    rm -f "$LOCK_FILE"

    if [[ $anything_done -eq 0 ]]; then
        echo ""
        echo -e "${YELLOW}⚠  Rien a desinstaller : XeLauncher n'est pas installe sur ce systeme.${RESET}"
        echo ""
    else
        ok "Desinstallation terminee"
    fi
}

print_summary() {
    echo ""
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
    if [[ "$MODE" == "install" && ${#FAILED_STEPS[@]} -gt 0 ]]; then
        echo -e "${YELLOW}! Installation terminee avec des avertissements${RESET}"
    elif [[ "$MODE" == "install" ]]; then
        echo -e "${GREEN}✔ Installation terminee avec succes !${RESET}"
    else
        echo -e "${GREEN}✔ Desinstallation terminee !${RESET}"
    fi
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
    echo ""

    if [[ ${#ACTIONS_DONE[@]} -eq 0 ]]; then
        echo "  Aucune action effectuee (tout etait deja en ordre)."
    else
        echo "  Ce qui a ete effectue :"
        for action in "${ACTIONS_DONE[@]}"; do
            echo -e "    ${GREEN}•${RESET} $action"
        done
    fi

    local step
    if [[ ${#FAILED_STEPS[@]} -gt 0 ]]; then
        echo ""
        echo "  A verifier :"
        for step in "${FAILED_STEPS[@]}"; do
            echo -e "    ${YELLOW}!${RESET} $step"
        done
    fi

    echo ""
    if [[ "$MODE" == "install" ]]; then
        echo -e "  ${CYAN}Redemarrez maintenant :${RESET} sudo reboot"
    fi
    echo ""
}

main() {
    for arg in "$@"; do
        case "$arg" in
            --i) AUTO_MODE="install" ;;
            --u) AUTO_MODE="uninstall" ;;
            --no-retropie|--skip-retropie) RETROPIE_CHOICE="no" ;;
            --retropie) RETROPIE_CHOICE="yes" ;;
            -h|--help) usage; exit 0 ;;
            *)
                echo -e "${RED}✖${RESET} Argument inconnu : $arg" >&2
                usage >&2
                exit 1
                ;;
        esac
    done

    if [[ $EUID -eq 0 ]]; then
        echo -e "\033[1;31m✖\033[0m N'executez pas ce script en root." >&2
        exit 1
    fi

    REAL_USER="${SUDO_USER:-$USER}"
    export HOME="/home/$REAL_USER"

    sudo -v || { echo "Droits sudo requis" >&2; exit 1; }

    curl -sSf --max-time 10 https://github.com > /dev/null 2>&1 \
        || { echo "Connexion Internet requise (github.com injoignable)" >&2; exit 1; }

    check_disk_space

    interactive_menu

    exec > >(trap '' INT; sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\x1b\[[0-9;]*[Rr]//g' | tee -a "$LOG_FILE") 2>&1

    if [[ "$MODE" == "uninstall" ]]; then
        uninstall_all
        print_summary
        exit 0
    fi

    section "1/10 — Mise a jour systeme"
    sudo apt-get update -q
    ok "Paquets a jour"

    section "2/10 — Dependances systeme"
    check_and_install_packages \
        git curl wget \
        network-manager wireless-tools \
        bluetooth bluez bluez-tools \
        flatpak \
        xdotool x11-utils xdg-desktop-portal-gtk \
        xserver-xorg xinit openbox \
        unzip jq dialog xmlstarlet \
        fbi \
        psmisc \
        plymouth plymouth-themes plymouth-label \
        python3 python3-evdev python3-xlib python3-plyvel python3-websocket \
        x11-xserver-utils xterm alsa-utils \
        pulseaudio-utils \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
        libxss1 libxtst6 libgtk-3-0 \
        chromium || true

    section "3/10 — Node.js"
    install_nodejs

    section "4/10 — Tailscale"
    install_tailscale

    section "5/10 — Flatpak + Jellyfin"
    install_flatpak_jellyfin

    section "6/10 — Clonage du depot"
    clone_or_update_repo

    section "7/10 — Dependances Node"
    install_npm_deps

    section "8/10 — RetroPie (optionnel)"
    install_retropie

    section "9/10 — Configuration entrees (evdev/Wiimote)"
    configure_input_system

    section "10/10 — Configuration du systeme"
    configure_boot_splash
    configure_retropie_menu
    create_start_script
    configure_autologin
    configure_systemd_service
    configure_sudoers
    create_required_dirs

    touch "$LOCK_FILE"
    print_summary
}

main "$@"
