#!/bin/bash
#
# Upgrade an existing Nightshift deployment to a new release.
#
# Downloads the new rootfs from GitHub Releases, upgrades nightshift-sdk
# from PyPI, and restarts the service.
#
# Usage:
#   ./infra/upgrade.sh ubuntu@100.49.58.14
#   ./infra/upgrade.sh ubuntu@100.49.58.14 --key ~/.ssh/nightshift.pem
#   ./infra/upgrade.sh ubuntu@100.49.58.14 --version v0.3.0
#   ./infra/upgrade.sh                     # reads from .deploy-state
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.deploy-state"
GITHUB_REPO="nightshiftco/nightshift"

SSH_KEY=""
TARGET=""
VERSION=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --key)     SSH_KEY="$2"; shift 2 ;;
        --version) VERSION="$2"; shift 2 ;;
        *)         TARGET="$1";  shift   ;;
    esac
done

# If no target given, read from deploy state file
if [ -z "$TARGET" ]; then
    if [ -f "$STATE_FILE" ]; then
        source "$STATE_FILE"
        TARGET="ubuntu@${ELASTIC_IP}"
        SSH_KEY="${SSH_KEY:-$KEY_PATH}"
        echo "==> Using instance from $STATE_FILE"
    else
        echo "Error: no target specified and $STATE_FILE not found"
        echo "Usage: $0 [--key <path>] [--version <tag>] <user@host>"
        exit 1
    fi
fi

# If no version specified, fetch latest release tag
if [ -z "$VERSION" ]; then
    VERSION=$(curl -s "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" | jq -r '.tag_name')
    if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
        echo "Error: could not determine latest release from GitHub"
        exit 1
    fi
fi

# Build SSH options
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
if [ -n "$SSH_KEY" ]; then
    SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

SDK_VERSION=$(echo "$VERSION" | sed 's/^v//')

echo "==> Upgrading Nightshift to $VERSION"
echo "    Target: $TARGET"
echo ""

# -------------------------------------------------------------------
# 1. Download new rootfs from GitHub Release
# -------------------------------------------------------------------
echo "==> Downloading rootfs.ext4.gz from GitHub Release $VERSION..."
ssh $SSH_OPTS "$TARGET" "curl -sSL -o /tmp/rootfs.ext4.gz \
    'https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/rootfs.ext4.gz' \
    && sudo -n mv /tmp/rootfs.ext4.gz /opt/nightshift/rootfs.ext4.gz \
    && sudo -n gunzip -f /opt/nightshift/rootfs.ext4.gz"
echo "    Done"

# -------------------------------------------------------------------
# 2. Upgrade nightshift-sdk via uvx
# -------------------------------------------------------------------
echo "==> Upgrading nightshift-sdk to $SDK_VERSION..."
ssh $SSH_OPTS "$TARGET" "export PATH=/home/ubuntu/.local/bin:/root/.local/bin:\$PATH; uv tool install --upgrade 'nightshift-sdk==${SDK_VERSION}'"
echo "    Done"

# -------------------------------------------------------------------
# 3. Restart service
# -------------------------------------------------------------------
echo "==> Restarting nightshift-serve..."
ssh $SSH_OPTS "$TARGET" "sudo -n systemctl restart nightshift-serve"

# -------------------------------------------------------------------
# 4. Verify
# -------------------------------------------------------------------
echo "==> Verifying service..."
sleep 3
STATUS=$(ssh $SSH_OPTS "$TARGET" "systemctl is-active nightshift-serve")
echo "    nightshift-serve: $STATUS"

if [ "$STATUS" != "active" ]; then
    echo "    WARNING: service is not active"
    echo "    Debug: ssh $SSH_OPTS $TARGET 'sudo journalctl -u nightshift-serve --no-pager -n 50'"
    exit 1
fi

# Update state file version if it exists
if [ -f "$STATE_FILE" ]; then
    sed -i '' "s/^VERSION=.*/VERSION=$VERSION/" "$STATE_FILE" 2>/dev/null || \
    sed -i "s/^VERSION=.*/VERSION=$VERSION/" "$STATE_FILE" 2>/dev/null || true
fi

echo ""
echo "=== Upgrade complete ==="
echo "    Version: $VERSION"
