#!/bin/bash
#
# Deploy code changes to a running Nightshift server.
#
# Syncs the project, re-bakes the rootfs with the latest agent runtime,
# and restarts the server. Warm VMs are invalidated on restart so the
# next run cold-starts with the new code.
#
# Usage:
#   ./infra/dev/deploy.sh                          # uses IP from .instance
#   ./infra/dev/deploy.sh ubuntu@100.49.58.14      # explicit host
#   ./infra/dev/deploy.sh --key ~/.ssh/my.pem ubuntu@host
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
STATE_FILE="$SCRIPT_DIR/.instance"

SSH_KEY=""
TARGET=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --key) SSH_KEY="$2"; shift 2 ;;
        *)     TARGET="$1";  shift   ;;
    esac
done

# If no target given, read from .instance state file
if [ -z "$TARGET" ]; then
    if [ -f "$STATE_FILE" ]; then
        source "$STATE_FILE"
        TARGET="ubuntu@${PUBLIC_IP}"
        SSH_KEY="${SSH_KEY:-$KEY_PATH}"
        echo "==> Using instance from $STATE_FILE"
    else
        echo "Error: no target specified and $STATE_FILE not found"
        echo "Usage: $0 [--key <path>] <user@host>"
        exit 1
    fi
fi

# Build SSH options
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
if [ -n "$SSH_KEY" ]; then
    SSH_OPTS="$SSH_OPTS -i $SSH_KEY"
fi

# Extract user@host and remote project path
REMOTE_USER="${TARGET%%@*}"
REMOTE_DIR="/home/${REMOTE_USER}/nightshift"

echo "==> Deploying to $TARGET"
echo "    Remote path: $REMOTE_DIR"
echo ""

# -------------------------------------------------------------------
# 1. Sync project to server
# -------------------------------------------------------------------
echo "==> Syncing project..."
rsync -az --delete \
    --exclude '.git' \
    --exclude '__pycache__' \
    --exclude '.venv' \
    --exclude 'node_modules' \
    --exclude '.mypy_cache' \
    --exclude '.pytest_cache' \
    -e "ssh $SSH_OPTS" \
    "$PROJECT_DIR/" "$TARGET:$REMOTE_DIR/"
echo "    Done"

# -------------------------------------------------------------------
# 2. Bake rootfs + restart server
# -------------------------------------------------------------------
echo "==> Baking rootfs and restarting server..."
ssh $SSH_OPTS "$TARGET" "sudo $REMOTE_DIR/infra/bake-rootfs.sh && sudo systemctl restart nightshift-serve"

# -------------------------------------------------------------------
# 3. Verify
# -------------------------------------------------------------------
echo "==> Waiting for server to come up..."
sleep 3
ssh $SSH_OPTS "$TARGET" "systemctl is-active nightshift-serve"

echo ""
echo "=== Deploy complete ==="
