#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# FB BAHI Panel — Ubuntu (22.04/24.04) & Debian VPS Installer & Lifecycle CLI
# ==============================================================================

INSTALL_DIR="/opt/fbbahi-panel"
SERVICE_NAME="fbbahi-panel.service"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"
BACKUP_DIR="/var/backups/fbbahi-panel"
PANEL_PORT="6767"
REPO_SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PURPLE="\033[1;35m"
CYAN="\033[1;36m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
RESET="\033[0m"

if [[ "${EUID}" -ne 0 ]]; then
  echo -e "${RED}[Error] This installer must be run as root. Try: sudo bash install.sh${RESET}"
  exit 1
fi

print_banner() {
  clear || true
  echo -e "${PURPLE}"
  cat <<'EOF'
 ███████╗██████╗     ██████╗  █████╗ ██╗  ██╗██╗
 ██╔════╝██╔══██╗    ██╔══██╗██╔══██╗██║  ██║██║
 █████╗  ██████╔╝    ██████╔╝███████║███████║██║
 ██╔══╝  ██╔══██╗    ██╔══██╗██╔══██║██╔══██║██║
 ██║     ██████╔╝    ██████╔╝██║  ██║██║  ██║██║
 ╚═╝     ╚═════╝     ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝
EOF
  echo -e "${CYAN}  Self-Hosted Game Server & Cloud VM Control Panel${RESET}"
  echo -e "${PURPLE}  =================================================${RESET}\n"
}

install_system_packages() {
  echo -e "${CYAN}[1/5] Updating apt packages and installing prerequisites...${RESET}"
  apt-get update -y
  apt-get install -y curl wget git ca-certificates gnupg lsb-release sqlite3 build-essential python3 make g++ rsync

  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 18 ]]; then
    echo -e "${CYAN}[2/5] Installing Node.js 20.x LTS...${RESET}"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    echo -e "${GREEN}[OK] Node.js $(node -v) already installed.${RESET}"
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo -e "${CYAN}[3/5] Installing Docker Engine...${RESET}"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
  else
    echo -e "${GREEN}[OK] Docker already installed.${RESET}"
    systemctl enable --now docker || true
  fi

  if ! command -v incus >/dev/null 2>&1; then
    echo -e "${CYAN}[4/5] Installing Incus (LXC & KVM Manager)...${RESET}"
    if apt-cache show incus >/dev/null 2>&1; then
      apt-get install -y incus
    else
      mkdir -p /etc/apt/keyrings
      curl -fsSL https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc
      local codename
      codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
      echo "deb [signed-by=/etc/apt/keyrings/zabbly.asc] https://pkgs.zabbly.com/incus/stable ${codename} main" > /etc/apt/sources.list.d/zabbly-incus-stable.list
      apt-get update -y
      apt-get install -y incus
    fi
    systemctl enable --now incus || true
    incus admin init --auto || true
  else
    echo -e "${GREEN}[OK] Incus already installed.${RESET}"
  fi
}

deploy_application_files() {
  echo -e "${CYAN}[5/5] Deploying panel files to ${INSTALL_DIR}...${RESET}"
  mkdir -p "${INSTALL_DIR}" "${INSTALL_DIR}/data/servers/mc" "${INSTALL_DIR}/data/servers/vm-backups" "${INSTALL_DIR}/uploads/backgrounds" "${INSTALL_DIR}/backups"
  rsync -a --exclude 'node_modules' --exclude 'data' --exclude 'uploads' --exclude 'backups' --exclude 'dist' --exclude 'server.js' --exclude '*.db*' --exclude '.env' --exclude '.git' "${REPO_SOURCE_DIR}/" "${INSTALL_DIR}/"

  if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
    local jwt_secret
    jwt_secret="$(openssl rand -hex 32)"
    cat > "${INSTALL_DIR}/.env" <<EOF
NODE_ENV=production
PORT=${PANEL_PORT}
DB_PATH=${INSTALL_DIR}/data/panel.db
DATA_DIR=${INSTALL_DIR}/data/servers
DOCKER_SOCKET=/var/run/docker.sock
JWT_SECRET=${jwt_secret}
EOF
    chmod 600 "${INSTALL_DIR}/.env"
  else
    if grep -q '^PORT=' "${INSTALL_DIR}/.env"; then
      sed -i "s/^PORT=.*/PORT=${PANEL_PORT}/" "${INSTALL_DIR}/.env"
    else
      echo "PORT=${PANEL_PORT}" >> "${INSTALL_DIR}/.env"
    fi
  fi

  pushd "${INSTALL_DIR}" >/dev/null
  npm install
  npm run build
  popd >/dev/null
}

configure_firewall_port() {
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    echo -e "${CYAN}[Firewall] Allowing port ${PANEL_PORT}/tcp in UFW...${RESET}"
    ufw allow "${PANEL_PORT}/tcp" >/dev/null 2>&1 || true
  fi
}

detect_public_ip() {
  local pub_ip=""
  pub_ip="$(curl -4 -fsS --max-time 3 https://api.ipify.org 2>/dev/null || true)"
  if [[ -z "${pub_ip}" ]]; then
    pub_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi
  echo "${pub_ip:-127.0.0.1}"
}

verify_panel_live() {
  local live=0
  local i
  for i in $(seq 1 15); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${PANEL_PORT}/api/auth/status" >/dev/null 2>&1; then
      live=1
      break
    fi
    sleep 1
  done

  local public_ip
  public_ip="$(detect_public_ip)"

  if [[ "${live}" -eq 1 ]]; then
    echo -e "\n${GREEN}[LIVE] FB BAHI Panel is listening on port ${PANEL_PORT}!${RESET}"
    echo -e "${GREEN}       Open: http://${public_ip}:${PANEL_PORT}${RESET}"
  else
    echo -e "\n${YELLOW}[Warning] Service started, but port ${PANEL_PORT} did not respond within 15s.${RESET}"
    echo -e "${YELLOW}          Check logs with: journalctl -u ${SERVICE_NAME} -n 50 --no-pager${RESET}"
    echo -e "${CYAN}          Expected URL: http://${public_ip}:${PANEL_PORT}${RESET}"
  fi
}

write_systemd_service() {
  cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=FB BAHI Panel - Game Server & Cloud VM Control Panel
After=network.target docker.service incus.service
Wants=docker.service

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
Environment=PORT=${PANEL_PORT}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/server.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

  configure_firewall_port
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"
  verify_panel_live
}

create_admin_interactive() {
  if [[ ! -f "${INSTALL_DIR}/create-admin.js" ]]; then
    echo -e "${RED}[Error] Panel is not installed in ${INSTALL_DIR}.${RESET}"
    return 1
  fi

  echo -e "\n${CYAN}--- Create / Update Owner/Admin User ---${RESET}"
  read -rp "Username: " admin_user
  read -rp "Email: " admin_email
  read -rsp "Password (hidden, min 8 chars): " admin_pass
  echo ""

  if [[ -z "${admin_user}" || -z "${admin_email}" || -z "${admin_pass}" ]]; then
    echo -e "${RED}[Error] All fields are required.${RESET}"
    return 1
  fi

  pushd "${INSTALL_DIR}" >/dev/null
  DB_PATH="${INSTALL_DIR}/data/panel.db" node "${INSTALL_DIR}/create-admin.js" "${admin_user}" "${admin_email}" "${admin_pass}"
  popd >/dev/null
  echo -e "${GREEN}[OK] Admin user saved.${RESET}"
}

action_install() {
  install_system_packages
  deploy_application_files
  write_systemd_service
  read -rp "Create the first Owner/Admin user now? [Y/n]: " create_now
  if [[ ! "${create_now}" =~ ^[Nn]$ ]]; then
    create_admin_interactive || true
  fi
}

action_reinstall() {
  echo -e "${YELLOW}[Reinstall] Stopping ${SERVICE_NAME}...${RESET}"
  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true

  if [[ -f "${INSTALL_DIR}/data/panel.db" ]]; then
    read -rp "Back up existing SQLite database before reinstalling? [Y/n]: " do_backup
    if [[ ! "${do_backup}" =~ ^[Nn]$ ]]; then
      mkdir -p "${BACKUP_DIR}"
      local stamp
      stamp="$(date +%Y%m%d-%H%M%S)"
      cp -a "${INSTALL_DIR}/data/panel.db" "${BACKUP_DIR}/panel-${stamp}.db"
      echo -e "${GREEN}[OK] Database backed up to ${BACKUP_DIR}/panel-${stamp}.db${RESET}"
    fi
  fi

  deploy_application_files
  write_systemd_service
  echo -e "${GREEN}[Success] FB BAHI Panel reinstalled and restarted.${RESET}"
}

action_uninstall() {
  read -rp "Are you sure you want to completely uninstall FB BAHI Panel? [y/N]: " confirm
  if [[ ! "${confirm}" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Uninstall cancelled.${RESET}"
    return 0
  fi

  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
  rm -f "${SERVICE_FILE}"
  systemctl daemon-reload
  rm -rf "${INSTALL_DIR}"
  echo -e "${GREEN}[Success] FB BAHI Panel and systemd service removed cleanly.${RESET}"
}

action_update() {
  if [[ ! -d "${INSTALL_DIR}" ]]; then
    echo -e "${RED}[Error] Panel is not installed in ${INSTALL_DIR}.${RESET}"
    return 1
  fi

  echo -e "${CYAN}[Update] Pulling latest panel updates (preserving database & server data)...${RESET}"
  pushd "${INSTALL_DIR}" >/dev/null
  if [[ -d ".git" ]]; then
    git pull --ff-only
  else
    rsync -a --exclude 'node_modules' --exclude 'data' --exclude 'uploads' --exclude 'backups' --exclude 'dist' --exclude 'server.js' --exclude '*.db*' --exclude '.env' --exclude '.git' "${REPO_SOURCE_DIR}/" "${INSTALL_DIR}/"
  fi
  mkdir -p "${INSTALL_DIR}/data/servers/mc" "${INSTALL_DIR}/data/servers/vm-backups" "${INSTALL_DIR}/uploads/backgrounds" "${INSTALL_DIR}/backups"
  npm install
  npm run build
  popd >/dev/null

  configure_firewall_port
  systemctl restart "${SERVICE_NAME}"
  verify_panel_live
  echo -e "${GREEN}[Success] FB BAHI Panel updated and restarted.${RESET}"
}

while true; do
  print_banner
  echo -e "  ${CYAN}[1]${RESET} Install panel"
  echo -e "  ${CYAN}[2]${RESET} Reinstall panel"
  echo -e "  ${CYAN}[3]${RESET} Uninstall panel"
  echo -e "  ${CYAN}[4]${RESET} Update panel"
  echo -e "  ${CYAN}[5]${RESET} Create owner/admin user"
  echo -e "  ${CYAN}[6]${RESET} Exit"
  echo ""
  read -rp "  Select [1 - 6]-> " choice

  case "${choice}" in
    1) action_install ;;
    2) action_reinstall ;;
    3) action_uninstall ;;
    4) action_update ;;
    5) create_admin_interactive ;;
    6)
      echo -e "${PURPLE}Goodbye from FB BAHI Panel!${RESET}"
      exit 0
      ;;
    *)
      echo -e "${RED}Invalid option. Please choose 1-6.${RESET}"
      ;;
  esac

  echo ""
  read -rp "Press Enter to return to menu..." _pause
done
