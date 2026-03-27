#!/bin/bash
# +--------------------------------------------------------------+
# |              XeLauncher — Script d'installation              |
# |           Prometheus Entertainment System — RPI5             |
# |                     Version améliorée                        |
# +--------------------------------------------------------------+

# --- Configuration des options shell ---
set -euo pipefail
trap 'error "Erreur fatale à la ligne $LINENO (code $?). Voir $LOG_FILE pour plus de détails."' ERR

# --- Variables globales ---
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

# --- Options par défaut ---
YES_MODE=0
FORCE_MODE=0
SKIP_RETROPIE=0

# --- Fonctions de logging ---
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

# --- Fonction d'aide ---
usage() {
    cat <<EOF
Usage: $0 [options]

Options:
  --yes          Mode automatique (ne demande aucune confirmation)
  --force        Force la réinstallation même si XeLauncher est déjà installé
  --skip-retropie  Saute l'installation de RetroPie
  --help         Affiche cette aide
EOF
    exit 0
}

# --- Traitement des arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --yes) YES_MODE=1; shift ;;
        --force) FORCE_MODE=1; shift ;;
        --skip-retropie) SKIP_RETROPIE=1; shift ;;
        --help) usage ;;
        *) error "Option inconnue: $1"; usage ;;
    esac
done

# --- Redirection de la sortie vers un fichier log tout en affichant à l'écran ---
exec > >(tee -a "$LOG_FILE") 2>&1

# --- Vérifications initiales ---
if [[ $EUID -eq 0 ]]; then
    error "Ce script ne doit pas être exécuté en tant que root. Utilisez un utilisateur normal avec des droits sudo."
    exit 1
fi

# Vérification de sudo
if ! sudo -v; then
    error "Vous devez avoir les droits sudo pour exécuter ce script."
    exit 1
fi

# Vérification du verrouillage
if [[ -f "$LOCK_FILE" ]] && [[ $FORCE_MODE -eq 0 ]]; then
    warn "XeLauncher semble déjà installé sur ce système. Utilisez --force pour réinstaller."
    exit 0
fi

# Vérification de la connexion Internet
if ! curl -Is https://github.com | head -n1 | grep -q 200; then
    error "Connexion Internet requise (accès à GitHub)."
    exit 1
fi

# Vérification de la plateforme
if ! grep -q "Raspberry" /proc/device-tree/model 2>/dev/null; then
    warn "Ce script est conçu pour Raspberry Pi. Continuer peut ne pas fonctionner."
    if [[ $YES_MODE -eq 0 ]]; then
        read -p "Voulez-vous continuer ? (o/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[OoYy]$ ]]; then
            exit 1
        fi
    fi
fi

# Vérification RAM
RAM=$(free -m | awk '/Mem:/ {print $2}')
if [[ $RAM -lt 2000 ]]; then
    warn "Moins de 2GB de RAM détecté, Electron peut être lent."
fi

# Espace disque
DISK_AVAIL=$(df -h "$HOME" | awk 'NR==2 {print $4}')
if [[ ${DISK_AVAIL%G} -lt 4 ]]; then
    warn "Moins de 4 Go d'espace disque disponible, l'installation peut échouer."
fi

# Déterminer l'utilisateur réel (même si sudo a été utilisé)
REAL_USER="${SUDO_USER:-$USER}"
export HOME="/home/$REAL_USER"

# --- Fonctions de vérification et d'installation ---

check_and_install_packages() {
    local packages=("$@")
    local to_install=()
    for pkg in "${packages[@]}"; do
        if ! dpkg -s "$pkg" &>/dev/null; then
            to_install+=("$pkg")
        fi
    done
    if [[ ${#to_install[@]} -gt 0 ]]; then
        log "Installation des paquets manquants: ${to_install[*]}"
        sudo apt-get install -y "${to_install[@]}"
    else
        ok "Tous les paquets sont déjà installés."
    fi
}

install_nodejs() {
    if command -v node >/dev/null 2>&1; then
        local node_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ $node_version -ge 20 ]]; then
            ok "Node.js version $(node -v) déjà installé."
            return 0
        else
            warn "Version de Node.js trop ancienne. Mise à jour vers 20.x."
        fi
    fi
    log "Installation de Node.js 20.x"
    curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/node_setup.sh
    sudo bash /tmp/node_setup.sh
    rm /tmp/node_setup.sh
    sudo apt-get install -y nodejs
    ok "Node.js installé: $(node -v)"
}

install_tailscale() {
    if command -v tailscale >/dev/null 2>&1; then
        ok "Tailscale déjà installé."
        return 0
    fi
    log "Installation de Tailscale"
    curl -fsSL https://tailscale.com/install.sh -o /tmp/tailscale_install.sh
    sudo bash /tmp/tailscale_install.sh
    rm /tmp/tailscale_install.sh
    sudo systemctl enable tailscaled
    sudo systemctl start tailscaled
    ok "Tailscale installé et démarré."
}

install_flatpak_jellyfin() {
    if ! command -v flatpak >/dev/null 2>&1; then
        log "Installation de flatpak"
        sudo apt-get install -y flatpak
    fi
    
    sudo flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo
    
    if flatpak info com.github.iwalton3.jellyfin-media-player >/dev/null 2>&1; then
        ok "Jellyfin Media Player déjà installé."
    else
        log "Installation de Jellyfin Media Player"
        sudo flatpak install -y flathub com.github.iwalton3.jellyfin-media-player
        ok "Jellyfin Media Player installé."
    fi
    
    # Configuration des permissions - Création du groupe flatpak si nécessaire
    log "Configuration des permissions flatpak"
    
    # Vérifier et créer le groupe flatpak s'il n'existe pas
    if ! getent group flatpak >/dev/null 2>&1; then
        log "Création du groupe flatpak"
        sudo groupadd flatpak
    fi
    
    # Ajouter l'utilisateur au groupe flatpak
    if ! groups "$REAL_USER" | grep -q "\bflatpak\b"; then
        sudo usermod -a -G flatpak "$REAL_USER"
        ok "Utilisateur ajouté au groupe flatpak"
    else
        ok "Utilisateur déjà dans le groupe flatpak"
    fi
    
    # Redémarrer le service flatpak s'il existe
    if systemctl list-units --full -all | grep -q flatpak-system-helper; then
        sudo systemctl restart flatpak-system-helper 2>/dev/null || true
    fi
    
    # Configurer les permissions D-Bus pour Jellyfin
    log "Configuration des permissions D-Bus pour Jellyfin"
    flatpak override --user --socket=wayland --socket=x11 --share=network --socket=session-bus com.github.iwalton3.jellyfin-media-player 2>/dev/null || true
    
    ok "Flatpak et Jellyfin configurés avec succès"
}

clone_or_update_repo() {
    if [[ -d "$INSTALL_DIR" ]]; then
        if [[ $FORCE_MODE -eq 1 ]]; then
            log "Suppression du répertoire existant pour forcer la réinstallation"
            rm -rf "$INSTALL_DIR"
        else
            log "Mise à jour du dépôt"
            cd "$INSTALL_DIR"
            # Stash des modifications locales éventuelles
            if ! git diff --quiet; then
                git stash push -m "auto-stash avant pull"
                warn "Modifications locales stashées."
            fi
            if ! git pull --rebase; then
                error "Échec du pull. Résolvez les conflits manuellement."
                exit 1
            fi
            ok "Dépôt mis à jour."
            return 0
        fi
    fi
    log "Clonage du dépôt XeLauncher"
    git clone "$REPO_URL" "$INSTALL_DIR"
    ok "Dépôt cloné."
}

install_npm_deps() {
    cd "$INSTALL_DIR"
    if [[ ! -f "package.json" ]]; then
        warn "package.json absent. Impossible d'installer les dépendances npm."
        return 1
    fi
    # Vérifier si node_modules existe et si package.json a changé
    if [[ -d "node_modules" ]]; then
        local pkg_hash=$(md5sum package.json | cut -d' ' -f1)
        local lock_hash=""
        if [[ -f "node_modules/.package-lock.json.hash" ]]; then
            lock_hash=$(cat "node_modules/.package-lock.json.hash")
        fi
        if [[ "$pkg_hash" == "$lock_hash" ]]; then
            ok "Dépendances npm déjà à jour."
            return 0
        fi
    fi
    log "Installation des dépendances npm"
    npm install
    # Sauvegarde du hash pour les prochaines vérifications
    md5sum package.json | cut -d' ' -f1 > node_modules/.package-lock.json.hash
    ok "Dépendances npm installées."
}

install_retropie() {
    if [[ $SKIP_RETROPIE -eq 1 ]]; then
        log "Installation de RetroPie ignorée (--skip-retropie)."
        return 0
    fi
    if command -v emulationstation >/dev/null 2>&1; then
        ok "RetroPie déjà installé."
        return 0
    fi
    log "Installation de RetroPie (peut prendre longtemps)"
    if [[ ! -d "$HOME/RetroPie-Setup" ]]; then
        git clone --depth=1 https://github.com/RetroPie/RetroPie-Setup.git "$HOME/RetroPie-Setup"
    fi
    cd "$HOME/RetroPie-Setup"
    sudo ./retropie_setup.sh auto
    mkdir -p "$HOME/RetroPie/roms"/{nes,snes,gb,gba,n64,psx,mame,arcade}
    ok "RetroPie installé."
}

configure_splashscreen() {
    local logo="$INSTALL_DIR/src/logos/Prometheus.png"
    if [[ ! -f "$logo" ]]; then
        warn "Logo Prometheus.png introuvable dans src/logos."
        return 1
    fi
    mkdir -p "$RETROPIE_SPLASH_DIR"
    cp "$logo" "$RETROPIE_SPLASH_DIR/prometheus.png"
    sudo mkdir -p "$(dirname "$RETROPIE_SPLASH_LIST")"
    # Éviter d'ajouter la ligne si déjà présente
    if ! grep -qxF "$RETROPIE_SPLASH_DIR/prometheus.png" "$RETROPIE_SPLASH_LIST" 2>/dev/null; then
        echo "$RETROPIE_SPLASH_DIR/prometheus.png" | sudo tee -a "$RETROPIE_SPLASH_LIST" >/dev/null
        ok "Splashscreen RetroPie configuré."
    else
        ok "Splashscreen déjà configuré."
    fi
}

create_start_script() {
    cat > "$INSTALL_DIR/start.sh" <<EOF
#!/bin/bash
export DISPLAY=:0
cd "$INSTALL_DIR"
exec npx electron . --no-sandbox --disable-dev-shm-usage
EOF
    chmod +x "$INSTALL_DIR/start.sh"
    ok "Script start.sh créé."
}

configure_autologin() {
    # Utiliser raspi-config si disponible, sinon configurer systemd-logind
    if command -v raspi-config >/dev/null 2>&1; then
        log "Configuration de l'autologin avec raspi-config"
        sudo raspi-config nonint do_boot_behaviour B2  # B2 = console autologin
        ok "Autologin configuré avec raspi-config"
    else
        # Méthode manuelle pour Debian/Raspbian
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
    # Créer le service qui démarre X avec le script
    sudo tee /etc/systemd/system/xelauncher.service > /dev/null <<EOF
[Unit]
Description=XeLauncher
After=systemd-user-sessions.service network.target

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
    ok "Service systemd xelauncher créé et activé."
}

configure_sudoers() {
    # Permettre à l'utilisateur d'exécuter certaines commandes sans mot de passe
    cat <<EOF | sudo tee "$SUDOERS_FILE" > /dev/null
$REAL_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl reboot, /usr/bin/systemctl poweroff, /usr/bin/tailscale up
EOF
    sudo chmod 440 "$SUDOERS_FILE"
    ok "Règles sudoers configurées."
}

create_required_dirs() {
    # Dossiers nécessaires pour l'application (avatars, etc.)
    mkdir -p "$INSTALL_DIR/avatars"
    ok "Dossiers requis créés."
}

# --- Fonction principale ---
main() {
    clear
    echo -e "${WHITE}XeLauncher Installer (version améliorée)${RESET}"
    echo ""

    if [[ $YES_MODE -eq 0 ]]; then
        read -p "Appuie sur Entrée pour commencer l'installation..."
    fi

    section "1/9 — Mise à jour système"
    sudo apt-get update
    ok "Paquets à jour."

    section "2/9 — Dépendances système"
    local deps=(
        git curl wget
        network-manager
        bluetooth bluez bluez-tools
        flatpak
        xdotool
        xserver-xorg xinit
        unzip jq dialog xmlstarlet
        fbi
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2
        libxss1 libxtst6 libgtk-3-0
    )
    check_and_install_packages "${deps[@]}"

    section "3/9 — Node.js"
    install_nodejs

    section "4/9 — Tailscale"
    install_tailscale

    section "5/9 — Flatpak + Jellyfin"
    install_flatpak_jellyfin

    section "6/9 — Clonage/mise à jour du dépôt"
    clone_or_update_repo

    section "7/9 — Dépendances Node"
    install_npm_deps

    section "8/9 — Installation RetroPie"
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
    echo "  - Splashscreen Prometheus configuré pour RetroPie"
    echo "  - Script start.sh créé"
    echo "  - Autologin configuré pour $REAL_USER"
    echo "  - Service systemd xelauncher activé"
    echo "  - Droits sudoers configurés"
    echo ""
    echo "Redémarrez maintenant pour tester : sudo reboot"
}

# Exécution
main "$@"