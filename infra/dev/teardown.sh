#!/bin/bash
#
# Terminate the dev instance and clean up local state.
#
# This script:
#   1. Reads instance details from infra/dev/.instance (created by setup.sh)
#   2. Calls aws ec2 terminate-instances to shut down and destroy the instance
#   3. Waits for the instance to reach the "terminated" state
#   4. Removes the .instance state file
#
# Note: This does NOT delete the SSH key pair or security group from AWS.
# Those are reusable across sessions — setup.sh will reuse them next time.
#
# IMPORTANT: c5.metal instances cost ~$4.08/hr. Always tear down when done.
#
# Usage: ./infra/dev/teardown.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.instance"

#
# If there's no .instance file, there's nothing to tear down. This can happen
# if you already ran teardown, or if setup.sh was never run.

if [ ! -f "$STATE_FILE" ]; then
    echo "ERROR: No instance found. Nothing to tear down."
    exit 1
fi

# Source the state file to get INSTANCE_ID, PUBLIC_IP, REGION.
source "$STATE_FILE"

#
# aws ec2 terminate-instances stops the instance and schedules it for deletion.
# The EBS root volume is set to DeleteOnTermination=true (in setup.sh), so
# the disk is automatically cleaned up too.
#
# --query extracts just the new state name from the response (e.g., "shutting-down").

echo "==> Terminating instance $INSTANCE_ID ($PUBLIC_IP)..."
aws ec2 terminate-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'TerminatingInstances[0].CurrentState.Name' \
    --output text

#
# Metal instances take longer to terminate than regular instances (sometimes
# several minutes). We wait so that a subsequent setup.sh doesn't hit the
# vCPU limit (96 vCPUs max means only one c5.metal at a time).
#
# The || true handles the case where the waiter times out — the instance
# will still terminate eventually, we just won't block on it.

echo "==> Waiting for termination (metal instances can take a few minutes)..."
aws ec2 wait instance-terminated \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" 2>/dev/null || true

#
# Remove the .instance file so test.sh and teardown.sh know there's no
# active instance. setup.sh will create a new one next time.

rm -f "$STATE_FILE"
echo "==> Done. Instance terminated and state cleaned up."
