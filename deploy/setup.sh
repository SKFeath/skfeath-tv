#!/usr/bin/env bash
# One-shot setup for the SKFeath TV fan-out (Homies room) server on a fresh
# Ubuntu VM (Oracle Always Free, Hetzner, etc.). Run as a normal sudo user:
#
#   bash setup.sh
#
# It installs Node, pulls the code, installs deps, and (once your .env is
# filled in) sets up a systemd service so the room auto-starts and
# auto-restarts. HTTPS is handled separately by Caddy - see deploy/README.md.
set -e

REPO="https://github.com/SKFeath/skfeath-tv.git"
APP_DIR="$HOME/skfeath-tv"

echo "== 1/5  system packages =="
sudo apt-get update -y
sudo apt-get install -y git curl

echo "== 2/5  Node.js 22 =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

echo "== 3/5  code + deps =="
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --omit=dev

echo "== 4/5  .env =="
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "  >>> Now edit  $APP_DIR/.env  with your NVision M3U/Xtream details"
  echo "      and your ACCESS_CODES (with ranks). Then re-run:  bash deploy/setup.sh"
  echo "      Edit with:   nano .env    (Ctrl-O saves, Ctrl-X exits)"
  exit 0
fi

echo "== 5/5  systemd service (auto-start, auto-restart) =="
sudo tee /etc/systemd/system/skfeath-tv.service >/dev/null <<UNIT
[Unit]
Description=SKFeath TV fan-out room
After=network.target
[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now skfeath-tv
sudo systemctl restart skfeath-tv

echo ""
echo "== done =="
echo "Room server running on port 3000."
echo "  status:  systemctl status skfeath-tv"
echo "  logs:    journalctl -u skfeath-tv -f"
echo "Next: set up HTTPS with Caddy (deploy/README.md), then tell me the URL"
echo "so I can wire it into the site's Room tab."
