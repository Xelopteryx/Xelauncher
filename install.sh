#!/bin/bash
# +--------------------------------------------------------------+
# |              XeLauncher — Script d'installation              |
# |           Prometheus Entertainment System — RPI5             |
# |                 Version totalement automatisée               |
# +--------------------------------------------------------------+

set -euo pipefail
trap 'error "Erreur fatale à la ligne $LINENO. Voir $LOG_FILE"' ERR

# Variables
readonly REPO_URL="https://github.com/Xelopteryx/Xelauncher.git"
readonly INSTALL_DIR="$HOME/xelauncher"
readonly LOCK_FILE="/var/tmp/xelauncher_install.lock"
readonly LOG_FILE="$HOME/xelauncher_install.log"
readonly RETROPIE_SPLASH_DIR="$HOME/RetroPie/splashscreens"
readonly RETROPIE_SPLASH_LIST="/opt/retropie/configs/all/splashscreen.list"
readonly SUDOERS_FILE="/etc/sudoers.d/xelauncher"

readonly RED='\033[1;31m'
readonly GREEN='\033[1;32m'
readonly YELLOW='\033[1;33m'
readonly CYAN='\033[0;36m'
readonly WHITE='\033[1;37m'
readonly RESET='\033[0m'

# Options
YES_MODE=0
FORCE_MODE=0
SKIP_RETROPIE=0

# Logging
log() { echo -e "${CYAN}→${RESET} $1"; }
ok() { echo -e "${GREEN}✔${RESET} $1"; }
warn() { echo -e "${YELLOW}!${RESET} $1"; }
error() { echo -e "${RED}✖${RESET} $1" >&2; }

section() {
    echo ""
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
    echo -e "${WHITE}$1${RESET}"
    echo -e "${WHITE}------------------------------------------------------------${RESET}"
}

usage() {
    cat <<EOF
Usage: $0 [options]

Options:
  --yes            Mode automatique (ne demande aucune confirmation)
  --force          Force la réinstallation même si déjà installé
  --skip-retropie  Saute l'installation de RetroPie
  --help           Affiche cette aide
EOF
    exit 0
}

# Arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes) YES_MODE=1; shift ;;
        --force) FORCE_MODE=1; shift ;;
        --skip-retropie) SKIP_RETROPIE=1; shift ;;
        --help) usage ;;
        *) error "Option inconnue: $1"; usage ;;
    esac
done

# Redirection de la sortie vers un fichier log
exec > >(tee -a "$LOG_FILE") 2>&1

# Vérifications initiales
if [[ $EUID -eq 0 ]]; then
    error "Ce script ne doit pas être exécuté en tant que root. Utilisez un utilisateur normal avec des droits sudo."
    exit 1
fi

sudo -v || { error "Droits sudo requis"; exit 1; }

if [[ -f "$LOCK_FILE" ]] && [[ $FORCE_MODE -eq 0 ]]; then
    warn "XeLauncher semble déjà installé. Utilisez --force pour réinstaller."
    exit 0
fi

curl -Is https://github.com | head -n1 | grep -q 200 || { error "Connexion Internet requise"; exit 1; }

if ! grep -q "Raspberry" /proc/device-tree/model 2>/dev/null; then
    warn "Ce script est conçu pour Raspberry Pi"
    if [[ $YES_MODE -eq 0 ]]; then
        read -p "Continuer ? (o/N) " -n 1 -r
        echo
        [[ ! $REPLY =~ ^[OoYy]$ ]] && exit 1
    fi
fi

RAM=$(free -m | awk '/Mem:/ {print $2}')
if [[ $RAM -lt 2000 ]]; then
    warn "Moins de 2GB de RAM, Electron peut être lent"
fi

DISK_AVAIL=$(df -h "$HOME" | awk 'NR==2 {print $4}')
if [[ ${DISK_AVAIL%G} -lt 4 ]]; then
    warn "Moins de 4 Go d'espace disque disponible"
fi

REAL_USER="${SUDO_USER:-$USER}"
export HOME="/home/$REAL_USER"

# Fonctions d'installation
check_and_install_packages() {
    local to_install=()
    for pkg in "$@"; do
        if ! dpkg -s "$pkg" &>/dev/null 2>&1; then
            to_install+=("$pkg")
        fi
    done
    if [[ ${#to_install[@]} -gt 0 ]]; then
        log "Installation des paquets manquants: ${to_install[*]}"
        sudo apt-get install -y "${to_install[@]}"
    fi
}

install_nodejs() {
    if command -v node >/dev/null 2>&1; then
        local node_version
        node_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ $node_version -ge 20 ]]; then
            ok "Node.js $(node -v) déjà installé"
            return 0
        else
            warn "Version Node.js trop ancienne, mise à jour vers 20.x"
        fi
    fi
    log "Installation de Node.js 20.x"
    curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/node_setup.sh
    sudo bash /tmp/node_setup.sh
    rm -f /tmp/node_setup.sh
    sudo apt-get install -y nodejs
    ok "Node.js installé: $(node -v)"
}

install_tailscale() {
    if command -v tailscale >/dev/null 2>&1; then
        ok "Tailscale déjà installé"
        return 0
    fi
    log "Installation de Tailscale"
    curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale_install.sh
    sudo bash /tmp/tailscale_install.sh
    rm -f /tmp/tailscale_install.sh
    sudo systemctl enable --now tailscaled 2>/dev/null || true
    ok "Tailscale installé"
}

install_flatpak_jellyfin() {
    if ! command -v flatpak >/dev/null 2>&1; then
        sudo apt-get install -y flatpak
    fi
    
    sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
    
    if ! flatpak info com.github.iwalton3.jellyfin-media-player >/dev/null 2>&1; then
        log "Installation de Jellyfin Media Player"
        exec >/dev/tty 2>&1
        sudo flatpak install -y flathub com.github.iwalton3.jellyfin-media-player
        exec > >(tee -a "$LOG_FILE") 2>&1
        ok "Jellyfin Media Player installé"
    else
        ok "Jellyfin Media Player déjà installé"
    fi
    
    log "Configuration des permissions flatpak"
    if ! getent group flatpak >/dev/null 2>&1; then
        sudo groupadd flatpak
    fi
    if ! groups "$REAL_USER" | grep -q "\bflatpak\b"; then
        sudo usermod -a -G flatpak "$REAL_USER"
        ok "Utilisateur ajouté au groupe flatpak"
    fi
    flatpak override --user --socket=x11 --share=network com.github.iwalton3.jellyfin-media-player 2>/dev/null || true
    ok "Flatpak et Jellyfin configurés"
}

clone_or_update_repo() {
    if [[ -d "$INSTALL_DIR" ]] && [[ $FORCE_MODE -eq 1 ]]; then
        log "Suppression du répertoire existant"
        rm -rf "$INSTALL_DIR"
    fi
    
    if [[ ! -d "$INSTALL_DIR" ]]; then
        log "Clonage du dépôt XeLauncher"
        git clone "$REPO_URL" "$INSTALL_DIR"
    else
        log "Mise à jour du dépôt"
        cd "$INSTALL_DIR"
        git stash push -m "auto-stash" 2>/dev/null || true
        git pull --rebase || { error "Échec de la mise à jour"; exit 1; }
    fi
    ok "Dépôt prêt"
}

install_npm_deps() {
    cd "$INSTALL_DIR"
    
    # Créer ou corriger package.json
    if [[ ! -f "package.json" ]]; then
        log "Création de package.json"
        cat > package.json <<'EOF'
{
  "name": "xelauncher",
  "version": "1.0.0",
  "main": "src/main.js",
  "dependencies": {
    "electron": "^28.0.0"
  },
  "devDependencies": {
    "electron-reload": "^1.5.0"
  }
}
EOF
    else
        # Corriger la version d'electron-reload si nécessaire
        if grep -q '"electron-reload": "\^2\.0\.0"' package.json 2>/dev/null; then
            log "Correction de la version electron-reload"
            sed -i 's/"electron-reload": "\^2\.0\.0"/"electron-reload": "\^1.5.0"/' package.json
        fi
    fi
    
    # Vérifier si les dépendances sont déjà installées
    local needs_install=0
    
    if [[ ! -d "node_modules" ]]; then
        needs_install=1
    else
        local pkg_hash=""
        local lock_hash=""
        
        if [[ -f "package.json" ]]; then
            pkg_hash=$(md5sum package.json 2>/dev/null | cut -d' ' -f1)
        fi
        
        if [[ -f "node_modules/.package-lock.json.hash" ]]; then
            lock_hash=$(cat "node_modules/.package-lock.json.hash" 2>/dev/null)
        fi
        
        if [[ -z "$pkg_hash" ]] || [[ -z "$lock_hash" ]] || [[ "$pkg_hash" != "$lock_hash" ]]; then
            needs_install=1
        fi
    fi
    
    if [[ $needs_install -eq 0 ]]; then
        ok "Dépendances npm déjà à jour"
        return 0
    fi
    
    log "Installation des dépendances npm"
    npm install
    
    if [[ -f "package.json" ]]; then
        md5sum package.json 2>/dev/null | cut -d' ' -f1 > node_modules/.package-lock.json.hash 2>/dev/null || true
    fi
    
    ok "Dépendances npm installées"
}

install_retropie() {
    if [[ $SKIP_RETROPIE -eq 1 ]]; then
        log "Installation de RetroPie ignorée (--skip-retropie)"
        return 0
    fi
    
    if command -v emulationstation >/dev/null 2>&1; then
        ok "RetroPie déjà installé"
        return 0
    fi
    
    log "Installation de RetroPie (20-40 minutes)"
    
    # Installer expect pour l'automatisation
    if ! command -v expect >/dev/null 2>&1; then
        log "Installation de expect pour l'automatisation"
        sudo apt-get update
        sudo apt-get install -y expect
    fi
    
    if [[ ! -d "$HOME/RetroPie-Setup" ]]; then
        git clone --depth=1 https://github.com/RetroPie/RetroPie-Setup.git "$HOME/RetroPie-Setup"
    fi
    
    cd "$HOME/RetroPie-Setup"
    
    # Désactiver la redirection pour l'affichage interactif
    exec >/dev/tty 2>&1
    
    log "Lancement de l'installation automatique de RetroPie (Basic Install)"
    
    # Automatisation complète avec expect
    expect << 'EOF'
set timeout 7200
log_user 1

# Lancer le script
spawn sudo ./retropie_setup.sh

expect {
    # Menu principal - choisir Basic Install (option 3)
    -re ".*Choose an option.*" {
        send "3\r"
        exp_continue
    }
    
    # Confirmation d'installation
    -re ".*Would you like to proceed.*" {
        send "y\r"
        exp_continue
    }
    
    # Écran "Press any key"
    -re ".*Press any key to continue.*" {
        send "\r"
        exp_continue
    }
    
    # Installation terminée
    -re ".*Setup is now complete.*" {
        send "q\r"
        exp_continue
    }
    
    # Gestion du temps d'attente
    timeout {
        send_user "\nTimeout - vérification de l'installation...\n"
    }
    
    eof {
        send_user "\nInstallation terminée\n"
    }
}

wait
EOF
    
    # Retour à la redirection normale
    exec > >(tee -a "$LOG_FILE") 2>&1
    
    # Créer les dossiers de ROMs
    mkdir -p "$HOME/RetroPie/roms"/{nes,snes,gb,gba,n64,psx,mame,arcade}
    
    # Vérifier si l'installation a réussi
    if command -v emulationstation >/dev/null 2>&1; then
        ok "RetroPie installé avec succès"
    else
        warn "L'installation de RetroPie peut nécessiter une intervention manuelle"
        warn "Pour l'installer plus tard: cd ~/RetroPie-Setup && sudo ./retropie_setup.sh"
    fi
}

configure_splashscreen() {
    local logo="$INSTALL_DIR/src/logos/Prometheus.png"
    if [[ -f "$logo" ]]; then
        mkdir -p "$RETROPIE_SPLASH_DIR"
        cp "$logo" "$RETROPIE_SPLASH_DIR/prometheus.png"
        sudo mkdir -p "$(dirname "$RETROPIE_SPLASH_LIST")"
        echo "$RETROPIE_SPLASH_DIR/prometheus.png" | sudo tee "$RETROPIE_SPLASH_LIST" >/dev/null
        ok "Splashscreen RetroPie configuré"
    else
        warn "Logo Prometheus.png introuvable"
    fi
}

create_start_script() {
    cat > "$INSTALL_DIR/start.sh" <<'EOF'
#!/bin/bash
export DISPLAY=:0
cd "$(dirname "$0")"
if [ -f "./node_modules/.bin/electron" ]; then
    exec ./node_modules/.bin/electron . --no-sandbox --disable-dev-shm-usage
else
    exec npx electron . --no-sandbox --disable-dev-shm-usage
fi
EOF
    chmod +x "$INSTALL_DIR/start.sh"
    ok "Script start.sh créé"
}

configure_autologin() {
    if command -v raspi-config >/dev/null 2>&1; then
        log "Configuration de l'autologin"
        sudo raspi-config nonint do_boot_behaviour B2
        ok "Autologin configuré"
    else
        log "Configuration manuelle de l'autologin"
        sudo mkdir -p /etc/systemd/system/getty@tty1.service.d
        cat <<EOF | sudo tee /etc/systemd/system/getty@tty1.service.d/override.conf
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin $REAL_USER --noclear %I \$TERM
EOF
        sudo systemctl daemon-reload
        ok "Autologin configuré manuellement"
    fi
}

configure_systemd_service() {
    sudo tee /etc/systemd/system/xelauncher.service > /dev/null <<EOF
[Unit]
Description=XeLauncher
After=network.target

[Service]
User=$REAL_USER
WorkingDirectory=$INSTALL_DIR
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/startx $INSTALL_DIR/start.sh -- :0
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable xelauncher
    ok "Service systemd xelauncher créé et activé"
}

configure_sudoers() {
    echo "$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/bin/tailscale up" | sudo tee "$SUDOERS_FILE" > /dev/null
    sudo chmod 440 "$SUDOERS_FILE"
    ok "Règles sudoers configurées"
}

create_required_dirs() {
    mkdir -p "$INSTALL_DIR/avatars"
    ok "Dossiers requis créés"
}

# Fonction principale
main() {
    clear
    echo -e "${WHITE}XeLauncher Installer (version automatisée)${RESET}"
    echo ""
    
    if [[ $YES_MODE -eq 0 ]]; then
        read -p "Appuie sur Entrée pour commencer l'installation..."
    fi
    
    section "1/9 — Mise à jour système"
    sudo apt-get update
    ok "Paquets à jour"
    
    section "2/9 — Dépendances système"
    check_and_install_packages \
        git curl wget \
        network-manager \
        bluetooth bluez bluez-tools \
        flatpak \
        xdotool \
        xserver-xorg xinit \
        unzip jq dialog xmlstarlet \
        fbi \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
        libxss1 libxtst6 libgtk-3-0
    
    section "3/9 — Node.js"
    install_nodejs
    
    section "4/9 — Tailscale"
    install_tailscale
    
    section "5/9 — Flatpak + Jellyfin"
    install_flatpak_jellyfin
    
    section "6/9 — Clonage du dépôt"
    clone_or_update_repo
    
    section "7/9 — Dépendances Node"
    install_npm_deps
    
    section "8/9 — RetroPie"
    install_retropie
    
    section "9/9 — Configuration du système"
    configure_splashscreen
    create_start_script
    configure_autologin
    configure_systemd_service
    configure_sudoers
    create_required_dirs
    
    # Finalisation
    touch "$LOCK_FILE"
    
    echo ""
    ok "Installation terminée avec succès !"
    echo ""
    echo "Résumé des actions effectuées :"
    echo "  - Dépendances système installées"
    echo "  - Node.js 20 installé"
    echo "  - Tailscale installé et démarré"
    echo "  - Jellyfin Media Player installé via flatpak"
    echo "  - Dépôt XeLauncher cloné/mis à jour"
    echo "  - Dépendances npm installées"
    echo "  - RetroPie installé" $([[ $SKIP_RETROPIE -eq 1 ]] && echo "(ignoré)" || echo "")
    echo "  - Splashscreen Prometheus configuré"
    echo "  - Script start.sh créé"
    echo "  - Autologin configuré pour $REAL_USER"
    echo "  - Service systemd xelauncher activé"
    echo "  - Droits sudoers configurés"
    echo ""
    echo "Redémarrez maintenant pour tester : sudo reboot"
}

# Exécution
main "$@"
