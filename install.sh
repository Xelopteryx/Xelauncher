#!/bin/bash
# +--------------------------------------------------------------+
# |              XeLauncher — Script d'installation              |
# |           Prometheus Entertainment System — RPI5/PC          |
# +--------------------------------------------------------------+

set -uo pipefail

readonly REPO_URL="https://github.com/Xelopteryx/Xelauncher.git"
readonly INSTALL_DIR="$HOME/xelauncher"
readonly LOCK_FILE="/var/tmp/xelauncher_install.lock"
readonly LOG_FILE="$HOME/xelauncher_install.log"
readonly SUDOERS_FILE="/etc/sudoers.d/xelauncher"
readonly PLYMOUTH_THEME_DIR="/usr/share/plymouth/themes/xe_theme"

readonly RED='\033[1;31m'
readonly GREEN='\033[1;32m'
readonly YELLOW='\033[1;33m'
readonly CYAN='\033[0;36m'
readonly WHITE='\033[1;37m'
readonly RESET='\033[0m'

AUTO_MODE=""
MODE=""
ACTIONS_DONE=()

log()         { echo -e "${CYAN}→${RESET} $1"; }
ok()          { echo -e "${GREEN}✔${RESET} $1"; }
warn()        { echo -e "${YELLOW}!${RESET} $1"; }
error()       { echo -e "${RED}✖${RESET} $1" >&2; }
done_action() { ACTIONS_DONE+=("$1"); }

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

detect_state() {
    HAS_RETROPIE=0
    HAS_JELLYFIN=0
    HAS_X=0
    HAS_NODE=0
    HAS_TAILSCALE=0
    HAS_REPO=0
    HAS_AUTOLOGIN=0

    command -v emulationstation >/dev/null 2>&1 && HAS_RETROPIE=1
    flatpak info com.github.iwalton3.jellyfin-media-player >/dev/null 2>&1 && HAS_JELLYFIN=1
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
            echo -e "${YELLOW}⚠  Mode automatique :${RESET} Installation en cours..."
        else
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
        echo -e "${YELLOW}⚠  Attention :${RESET} L'installation peut durer ${WHITE}une heure ou plus${RESET},"
        echo    "   notamment a cause de RetroPie."
        echo    "   Assurez-vous que le systeme reste allume et connecte a Internet."
    else
        echo -e "${RED}⚠  Desinstallation :${RESET} Tout ce qu'XeLauncher a installe sera supprime."
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
    local to_install=()
    for pkg in "$@"; do
        if ! dpkg -s "$pkg" 2>/dev/null | grep -q "^Status: install ok installed"; then
            to_install+=("$pkg")
        fi
    done
    if [[ ${#to_install[@]} -gt 0 ]]; then
        log "Installation des paquets manquants: ${to_install[*]}"
        sudo apt-get install -y "${to_install[@]}" \
            || { error "Echec installation paquets: ${to_install[*]}"; exit 1; }
        done_action "Paquets systeme installes : ${to_install[*]}"
    fi
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
        sudo flatpak install -y flathub com.github.iwalton3.jellyfin-media-player \
            2>&1 | grep -v $'^\033' | tee -a "$LOG_FILE" || \
            { error "Echec installation Jellyfin"; exit 1; }
        ok "Jellyfin Media Player installe"
        done_action "Jellyfin Media Player installe via flatpak"
    else
        log "Mise a jour de Jellyfin Media Player"
        flatpak update -y com.github.iwalton3.jellyfin-media-player 2>/dev/null \
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
        com.github.iwalton3.jellyfin-media-player 2>/dev/null || true
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
    if [[ $HAS_RETROPIE -eq 1 ]]; then
        ok "RetroPie deja installe"
        return 0
    fi

    if [[ "$PLATFORM" == "rpi5" ]]; then
        log "Installation de RetroPie sur Raspberry Pi 5 (optimisee)"
        if ! grep -q "dtoverlay=vc4-kms-v3d" /boot/config.txt 2>/dev/null; then
            echo "dtoverlay=vc4-kms-v3d" | sudo tee -a /boot/config.txt
            log "Configuration GPU ajoutee (redemarrage requis plus tard)"
        fi
    else
        log "Installation de RetroPie (20-40 minutes)"
    fi

    if [[ ! -d "$HOME/RetroPie-Setup" ]]; then
        git clone --depth=1 https://github.com/RetroPie/RetroPie-Setup.git "$HOME/RetroPie-Setup" \
            || { error "Echec clonage RetroPie-Setup"; exit 1; }
    fi

    cd "$HOME/RetroPie-Setup"
    git pull --rebase 2>/dev/null || true

    log "Lancement de l'installation RetroPie..."
    sudo __nodialog=1 ./retropie_packages.sh setup basic_install \
        || { error "Echec installation RetroPie"; exit 1; }

    mkdir -p "$HOME/RetroPie/roms"/{nes,snes,gb,gba,n64,psx,mame,arcade}

    if command -v emulationstation >/dev/null 2>&1; then
        ok "RetroPie installe avec succes"
        done_action "RetroPie installe (basic_install)"
    else
        warn "RetroPie n'a pas pu etre confirme. Verifiez $LOG_FILE"
    fi
}

configure_retropie_menu() {
    local cfg="/etc/emulationstation/es_systems.cfg"
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

configure_boot_splash() {
    local logo="$INSTALL_DIR/src/LOGOs/prometheus.png"
    local theme_src="$INSTALL_DIR/src/PLYMOUTHs/xe_theme"

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
        if command -v update-initramfs >/dev/null 2>&1; then
            sudo update-initramfs -u || warn "update-initramfs a echoue — le theme peut necessiter un redemarrage supplementaire"
        fi
        ok "Theme Plymouth xe_theme installe et active"
        done_action "Theme Plymouth xe_theme installe et defini par defaut"
    else
        sudo cp -f "$theme_src/xe_theme.plymouth" "$theme_src/xe_theme.script" "$PLYMOUTH_THEME_DIR/" 2>/dev/null || true
        ok "Theme Plymouth xe_theme deja actif (fichiers resynchronises)"
    fi

    # -- S'assurer que Plymouth est actif au boot (quiet splash) --
    local cmdline="/boot/firmware/cmdline.txt"
    [[ -f "$cmdline" ]] || cmdline="/boot/cmdline.txt"
    if [[ -f "$cmdline" ]]; then
        local changed=0
        grep -q '\bsplash\b' "$cmdline" || { sudo sed -i '1 s/$/ splash/' "$cmdline"; changed=1; }
        grep -q '\bquiet\b' "$cmdline" || { sudo sed -i '1 s/$/ quiet/' "$cmdline"; changed=1; }
        # Au cas ou une precedente config RetroPie l'aurait desactive
        if grep -q 'plymouth.enable=0' "$cmdline"; then
            sudo sed -i 's/ *plymouth\.enable=0//' "$cmdline"
            changed=1
        fi
        [[ $changed -eq 1 ]] && done_action "$cmdline mis a jour (quiet splash, plymouth.enable=0 retire si present)"
    fi

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
python3 "$INSTALL_DIR/scripts/xe_cursor_pin.py" &

exec "$INSTALL_DIR/xelauncher.sh"
EOF
    chmod +x "$HOME/.xinitrc"
    ok "Fichier .xinitrc cree (openbox + xe_cursor_pin.py + xelauncher.sh)"
    done_action "~/.xinitrc cree ; start.sh/xelauncher.sh du depot rendus executables"
}

configure_autologin() {
    if command -v raspi-config >/dev/null 2>&1; then
        log "Configuration de l'autologin console via raspi-config"
        sudo raspi-config nonint do_boot_behaviour B2
        ok "Autologin console configure"
        done_action "Autologin TTY1 configure via raspi-config"
    else
        log "Configuration manuelle de l'autologin sur TTY1"
        sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
        cat <<EOF | sudo tee /etc/systemd/system/getty@tty1.service.d/override.conf
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $REAL_USER --noclear %I \$TERM
EOF
        sudo systemctl daemon-reload
        ok "Autologin configure manuellement"
        done_action "Autologin TTY1 configure manuellement (systemd)"
    fi

    local BASH_PROFILE="$HOME/.bash_profile"

    if ! grep -q "XeLauncher" "$BASH_PROFILE" 2>/dev/null; then
        if ! grep -q '\.bashrc' "$BASH_PROFILE" 2>/dev/null; then
            echo '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"' >> "$BASH_PROFILE"
        fi
        cat >> "$BASH_PROFILE" <<'EOF'

# Lancement de XeLauncher (Prometheus Entertainment System)
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
    echo "Demarrage de XeLauncher..."
    exec startx "$HOME/.xinitrc" -- :0 vt1 -nolisten tcp
fi
EOF
        ok "XeLauncher ajoute au demarrage dans .bash_profile"
        done_action "~/.bash_profile configure (startx sur TTY1)"
    else
        if grep -q "exec startx ./start.sh\|cd.*xelauncher" "$BASH_PROFILE" 2>/dev/null; then
            sed -i '/# Lancement de XeLauncher/,/^fi$/d' "$BASH_PROFILE"
            cat >> "$BASH_PROFILE" <<'EOF'

# Lancement de XeLauncher (Prometheus Entertainment System)
if [ -z "$DISPLAY" ] && [ "$(tty)" = "/dev/tty1" ]; then
    echo "Demarrage de XeLauncher..."
    exec startx "$HOME/.xinitrc" -- :0 vt1 -nolisten tcp
fi
EOF
            ok ".bash_profile mis a jour (ancienne entree corrigee)"
            done_action "~/.bash_profile corrige"
        else
            ok "XeLauncher deja correctement configure dans .bash_profile"
        fi
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
    echo "$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/bin/tailscale up" \
        | sudo tee "$SUDOERS_FILE" > /dev/null
    sudo chmod 440 "$SUDOERS_FILE"
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

    # Support Wiimote (hid-wiimote) : module a charger au boot
    local modules_file="/etc/modules-load.d/xelauncher.conf"
    if [[ ! -f "$modules_file" ]] || ! grep -q "^hid-wiimote$" "$modules_file" 2>/dev/null; then
        echo "hid-wiimote" | sudo tee -a "$modules_file" >/dev/null
        sudo modprobe hid-wiimote 2>/dev/null || warn "hid-wiimote non charge (module absent ou deja charge)"
        changed=1
    fi

    if [[ $changed -eq 1 ]]; then
        ok "Systeme d'entree configure (groupes input/bluetooth, module hid-wiimote)"
        done_action "Groupes input/bluetooth + module hid-wiimote configures"
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
        "$INSTALL_DIR/src/PLYMOUTHs" \
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
    sudo flatpak uninstall -y com.github.iwalton3.jellyfin-media-player 2>/dev/null || true
    sudo flatpak uninstall -y --unused 2>/dev/null || true
    ok "Jellyfin desinstalle"
    done_action "Jellyfin Media Player desinstalle"
    anything_done=1

    log "Desinstallation de RetroPie"
    if [[ -d "$HOME/RetroPie-Setup" ]]; then
        cd "$HOME/RetroPie-Setup"
        sudo __nodialog=1 ./retropie_packages.sh setup remove_all 2>/dev/null || true
    fi
    sudo rm -rf "$HOME/RetroPie-Setup"
    sudo rm -rf "$HOME/RetroPie"
    sudo rm -rf /opt/retropie
    sudo rm -f /usr/bin/emulationstation
    sudo apt-get remove -y emulationstation 2>/dev/null || true
    ok "RetroPie desinstalle"
    done_action "RetroPie desinstalle"
    anything_done=1

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

    if [[ -f "/etc/modules-load.d/xelauncher.conf" ]]; then
        sudo rm -f "/etc/modules-load.d/xelauncher.conf"
        ok "Chargement hid-wiimote au boot supprime"
        done_action "/etc/modules-load.d/xelauncher.conf supprime"
        anything_done=1
    fi

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
    if [[ "$MODE" == "install" ]]; then
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
            *)
                echo -e "${RED}✖${RESET} Argument inconnu : $arg" >&2
                echo "  Usage : $0 [--i | --u]" >&2
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

    exec > >(sed 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\x1b\[[0-9;]*[Rr]//g' | tee -a "$LOG_FILE") 2>&1

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
        plymouth plymouth-themes \
        python3 python3-evdev python3-xlib \
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

    section "8/10 — RetroPie"
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
