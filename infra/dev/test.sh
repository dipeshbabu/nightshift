#!/bin/bash
#
# Sync the nightshift Python project to the dev instance and run e2e tests.
#
# This script:
#   1. Reads instance details from infra/.instance (created by setup.sh)
#   2. Uses rsync to copy the local python/ directory to the remote instance,
#      excluding build artifacts (.venv, __pycache__, etc.)
#   3. Runs `uv sync` on the remote to install Python dependencies
#   4. Runs the e2e test suite with sudo (Firecracker + TAP devices need root)
#
# The e2e test (tests/test_e2e_vm.py) does the following:
#   - Downloads the opencode binary
#   - Creates a rootfs overlay and injects opencode into it
#   - Sets up a TAP device for host↔VM networking
#   - Boots a Firecracker VM with the overlay rootfs
#   - Verifies the VM is reachable via ping
#   - Polls the opencode health endpoint inside the VM
#   - Cleans up (kills VM, removes TAP, deletes temp files)
#
# Usage: ./infra/dev/test.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Go up two levels from infra/dev/ to get the project root.
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

STATE_FILE="$SCRIPT_DIR/.instance"

#
# The .instance file is written by setup.sh and contains:
#   INSTANCE_ID=i-0abc123...
#   PUBLIC_IP=1.2.3.4
#   KEY_PATH=~/.ssh/nightshift-dev.pem
#   REGION=us-east-1

if [ ! -f "$STATE_FILE" ]; then
    echo "ERROR: No instance found. Run ./infra/dev/setup.sh first."
    exit 1
fi

source "$STATE_FILE"

# Build an SSH command prefix we'll reuse throughout.
#   -o StrictHostKeyChecking=no: don't prompt about unknown host keys
#   -i $KEY_PATH: use the private key created by setup.sh
SSH="ssh -o StrictHostKeyChecking=no -i $KEY_PATH ubuntu@$PUBLIC_IP"

# Where we put the project on the remote instance.
REMOTE_DIR="/home/ubuntu/nightshift"

echo "==> Instance: $INSTANCE_ID ($PUBLIC_IP)"
echo ""

#
# rsync copies only changed files over SSH. Flags:
#   -a: archive mode (preserves permissions, timestamps, symlinks)
#   -v: verbose (show files being transferred)
#   -z: compress during transfer
#   --delete: remove files on remote that don't exist locally (keeps in sync)
#   --exclude: skip directories that are environment-specific or generated
#     .venv/: Python virtualenv (recreated by `uv sync` on remote)
#     __pycache__/: Python bytecode cache
#     .pytest_cache/: pytest cache
#     .ruff_cache/: ruff linter cache
#     infra/dev/.instance: local state file, not needed on remote

echo "==> Syncing project to instance..."
rsync -avz --delete \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude '.pytest_cache' \
    --exclude '.ruff_cache' \
    --exclude 'infra/dev/.instance' \
    -e "ssh -o StrictHostKeyChecking=no -i $KEY_PATH" \
    "$PROJECT_DIR/" "ubuntu@$PUBLIC_IP:$REMOTE_DIR/"
echo ""

#
# `uv sync` reads pyproject.toml and installs all dependencies into a .venv
# on the remote instance. uv is installed under the ubuntu user's home dir
# by setup.sh's user-data script, so we add it to PATH.

echo "==> Installing dependencies..."
$SSH "cd $REMOTE_DIR && export PATH=/home/ubuntu/.local/bin:\$PATH && uv sync 2>&1"
echo ""

#
# We run pytest with sudo because the e2e test needs root to:
#   - Create TAP devices (ip tuntap add)
#   - Set iptables rules (NAT masquerading for VM internet access)
#   - Mount/unmount rootfs ext4 images (loop devices)
#   - Access /dev/kvm
#
# We use the full path to uv (/home/ubuntu/.local/bin/uv) because sudo
# doesn't inherit the ubuntu user's PATH.
#
# Flags:
#   -v: verbose test output (show test names and results)
#   -s: don't capture stdout (show print() output from tests in real time)

echo "==> Running e2e tests..."
$SSH "cd $REMOTE_DIR && sudo /home/ubuntu/.local/bin/uv run pytest tests/test_e2e_vm.py -v -s 2>&1"
