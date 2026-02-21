#!/bin/bash
#
# Deploy Nightshift in production with Caddy (auto-TLS) and systemd.
#
# This script is standalone — anyone can run it on a fresh machine that
# already has Nightshift installed (via uv) to set up a production server.
# It does NOT handle DNS; point your hostname at this machine first.
#
# Usage:
#   ./infra/production.sh --hostname api.nightshift.sh
#   ./infra/production.sh --hostname api.nightshift.sh --port 8080
#   ./infra/production.sh --hostname api.nightshift.sh --api-key my-secret-key
#
set -euo pipefail

# -------------------------------------------------------------------
# Parse arguments
# -------------------------------------------------------------------
HOSTNAME=""
PORT=3000
API_KEY=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --hostname) HOSTNAME="$2"; shift 2 ;;
        --port)     PORT="$2";     shift 2 ;;
        --api-key)  API_KEY="$2";  shift 2 ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 --hostname <FQDN> --api-key <key> [--port <port>]"
            exit 1
            ;;
    esac
done

if [ -z "$HOSTNAME" ]; then
    echo "Error: --hostname is required"
    echo "Usage: $0 --hostname <FQDN> --api-key <key> [--port <port>]"
    exit 1
fi

if [ -z "$API_KEY" ]; then
    echo "Error: --api-key is required"
    echo "This is the bootstrap key used for initial authentication."
    echo "Generate one with: python -c \"import secrets; print(f'ns_{secrets.token_hex(16)}')\""
    echo "Usage: $0 --hostname <FQDN> --api-key <key> [--port <port>]"
    exit 1
fi

echo "==> Nightshift production deployment"
echo "    Hostname: $HOSTNAME"
echo "    Backend port: $PORT"
echo ""

# -------------------------------------------------------------------
# 1. Install Caddy (if not already installed)
# -------------------------------------------------------------------
if ! command -v caddy &>/dev/null; then
    echo "==> Installing Caddy..."
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt-get update -y
    sudo apt-get install -y caddy
    echo "    Caddy installed"
else
    echo "==> Caddy already installed: $(caddy version)"
fi

# -------------------------------------------------------------------
# 2. Find nightshift project directory
# -------------------------------------------------------------------
# Default to the directory containing this script's parent, but allow
# override via NIGHTSHIFT_PROJECT_DIR.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="${NIGHTSHIFT_PROJECT_DIR:-$(dirname "$SCRIPT_DIR")}"

# Verify uv is available
UV_PATH="$(command -v uv 2>/dev/null || echo "$HOME/.local/bin/uv")"
if [ ! -x "$UV_PATH" ]; then
    echo "Error: uv not found. Install it first: curl -LsSf https://astral.sh/uv/install.sh | bash"
    exit 1
fi

# -------------------------------------------------------------------
# 3. Create systemd service for nightshift serve
# -------------------------------------------------------------------
echo "==> Creating systemd service: nightshift-serve"

SERVICE_ENV="Environment=NIGHTSHIFT_API_KEY=$API_KEY"

sudo tee /etc/systemd/system/nightshift-serve.service > /dev/null << EOF
[Unit]
Description=Nightshift Platform Server
After=network.target

[Service]
Type=simple
User=root
ExecStart=$UV_PATH run --project $PROJECT_DIR nightshift serve --port $PORT
Restart=on-failure
RestartSec=5
Environment=HOME=$HOME
$SERVICE_ENV
WorkingDirectory=$PROJECT_DIR

[Install]
WantedBy=multi-user.target
EOF

echo "    Created /etc/systemd/system/nightshift-serve.service"

# -------------------------------------------------------------------
# 4. Configure Caddy as TLS reverse proxy
# -------------------------------------------------------------------
echo "==> Configuring Caddy for $HOSTNAME"

sudo tee /etc/caddy/Caddyfile > /dev/null << EOF
$HOSTNAME {
    reverse_proxy localhost:$PORT
}
EOF

echo "    Created /etc/caddy/Caddyfile"

# -------------------------------------------------------------------
# 5. Enable and start services
# -------------------------------------------------------------------
echo "==> Starting services..."

sudo systemctl daemon-reload
sudo systemctl enable --now nightshift-serve
sudo systemctl enable caddy
sudo systemctl reload caddy

echo "    nightshift-serve: $(systemctl is-active nightshift-serve)"
echo "    caddy: $(systemctl is-active caddy)"

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------
echo ""
echo "=== Nightshift production deployment complete ==="
echo ""
echo "  Server:  https://$HOSTNAME"
echo "  Health:  https://$HOSTNAME/health"
echo ""
echo "  Logs:    sudo journalctl -u nightshift-serve -f"
echo "  Caddy:   sudo journalctl -u caddy -f"
echo ""
echo "  Note: TLS certificates are provisioned automatically by Caddy."
echo "  Make sure ports 80 and 443 are open and DNS points to this machine."
