#!/bin/bash
#
# Deploy Nightshift for operators.
#
# Provisions a c5.metal EC2 instance and bootstraps a production-ready
# Nightshift server. Everything is pulled from PyPI (nightshift-sdk) and
# GitHub Releases (rootfs.ext4.gz) — no local repo checkout needed.
#
# Prerequisites:
#   - AWS CLI configured with EC2/VPC permissions
#   - A hostname with DNS pointing to the Elastic IP (printed at the end)
#
# Usage:
#   ./infra/deploy.sh --hostname api.example.com --api-key ns_abc123
#   ./infra/deploy.sh --hostname api.example.com --api-key ns_abc123 --region us-west-2
#   ./infra/deploy.sh --hostname api.example.com --api-key ns_abc123 --version v0.2.0
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.deploy-state"

INSTANCE_TYPE="c5.metal"
KEY_NAME="nightshift"
SG_NAME="nightshift"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
HOSTNAME=""
API_KEY=""
PORT=3000
VERSION=""
GITHUB_REPO="nightshiftco/nightshift"

# -------------------------------------------------------------------
# Parse arguments
# -------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        --hostname) HOSTNAME="$2"; shift 2 ;;
        --api-key)  API_KEY="$2";  shift 2 ;;
        --region)   REGION="$2";   shift 2 ;;
        --version)  VERSION="$2";  shift 2 ;;
        --port)     PORT="$2";     shift 2 ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 --hostname <FQDN> --api-key <key> [--region <region>] [--version <tag>] [--port <port>]"
            exit 1
            ;;
    esac
done

if [ -z "$HOSTNAME" ]; then
    echo "Error: --hostname is required"
    echo "Usage: $0 --hostname <FQDN> --api-key <key> [--region <region>] [--version <tag>] [--port <port>]"
    exit 1
fi

if [ -z "$API_KEY" ]; then
    echo "Error: --api-key is required"
    echo "Generate one with: python3 -c \"import secrets; print(f'ns_{secrets.token_hex(16)}')\""
    exit 1
fi

# If no version specified, fetch the latest release tag from GitHub.
if [ -z "$VERSION" ]; then
    VERSION=$(curl -s "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" | jq -r '.tag_name')
    if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
        echo "Error: could not determine latest release from GitHub"
        exit 1
    fi
fi

echo "==> Nightshift operator deploy"
echo "    Hostname: $HOSTNAME"
echo "    Version:  $VERSION"
echo "    Region:   $REGION"
echo "    Port:     $PORT"
echo ""

# -------------------------------------------------------------------
# 1. SSH key pair
# -------------------------------------------------------------------
if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" &>/dev/null; then
    echo "==> Creating key pair: $KEY_NAME"
    aws ec2 create-key-pair \
        --key-name "$KEY_NAME" \
        --region "$REGION" \
        --query 'KeyMaterial' \
        --output text > ~/.ssh/${KEY_NAME}.pem
    chmod 400 ~/.ssh/${KEY_NAME}.pem
    echo "    Saved to ~/.ssh/${KEY_NAME}.pem"
else
    echo "==> Key pair '$KEY_NAME' already exists in AWS"
    if [ ! -f ~/.ssh/${KEY_NAME}.pem ]; then
        echo "    ERROR: Private key not found at ~/.ssh/${KEY_NAME}.pem"
        echo "    The key pair exists in AWS but the local private key is missing."
        echo "    Fix: delete the key pair in AWS and re-run this script."
        echo "      aws ec2 delete-key-pair --key-name $KEY_NAME --region $REGION"
        exit 1
    fi
fi

# -------------------------------------------------------------------
# 2. Security group — SSH + HTTP + HTTPS
# -------------------------------------------------------------------
SG_ID=$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=$SG_NAME" \
    --region "$REGION" \
    --query 'SecurityGroups[0].GroupId' \
    --output text 2>/dev/null || echo "None")

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
    echo "==> Creating security group: $SG_NAME"
    SG_ID=$(aws ec2 create-security-group \
        --group-name "$SG_NAME" \
        --description "Nightshift production — SSH + HTTP + HTTPS" \
        --region "$REGION" \
        --query 'GroupId' \
        --output text)
fi

MY_IP=$(curl -s https://checkip.amazonaws.com)
echo "==> Updating security group rules"

# Remove stale SSH rules
OLD_RULES=$(aws ec2 describe-security-groups \
    --group-ids "$SG_ID" \
    --region "$REGION" \
    --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp' \
    --output text 2>/dev/null || echo "")
for cidr in $OLD_RULES; do
    aws ec2 revoke-security-group-ingress \
        --group-id "$SG_ID" \
        --protocol tcp --port 22 --cidr "$cidr" \
        --region "$REGION" &>/dev/null || true
done

# SSH from operator IP + HTTP/HTTPS from anywhere
aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr "${MY_IP}/32" \
    --region "$REGION" &>/dev/null || true
aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp --port 80 --cidr "0.0.0.0/0" \
    --region "$REGION" &>/dev/null || true
aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp --port 443 --cidr "0.0.0.0/0" \
    --region "$REGION" &>/dev/null || true
echo "    Security group: $SG_ID (SSH: ${MY_IP}/32, HTTP/HTTPS: 0.0.0.0/0)"

# -------------------------------------------------------------------
# 3. Find latest Ubuntu 22.04 AMI
# -------------------------------------------------------------------
AMI_ID=$(aws ec2 describe-images \
    --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
              "Name=state,Values=available" \
    --region "$REGION" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text)
echo "==> AMI: $AMI_ID (Ubuntu 22.04 latest)"

# -------------------------------------------------------------------
# 4. Build user-data bootstrap script
# -------------------------------------------------------------------
# Variable substitution: VERSION, PORT, API_KEY, HOSTNAME, GITHUB_REPO
# are injected into the heredoc. The rest of the script runs as root on
# first boot.

USERDATA=$(cat << USERDATA_EOF
#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/nightshift-setup.log) 2>&1

# ── System packages ──────────────────────────────────────────────────
apt-get update
apt-get upgrade -y
apt-get install -y curl wget jq acl iptables iproute2 rsync

# ── KVM access ───────────────────────────────────────────────────────
modprobe kvm
modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
chmod 666 /dev/kvm
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' > /etc/udev/rules.d/99-kvm.rules

# ── IP forwarding ────────────────────────────────────────────────────
echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-firecracker.conf
sysctl -p /etc/sysctl.d/99-firecracker.conf

# ── uv (system-wide to /root/.local/bin) ─────────────────────────────
curl -LsSf https://astral.sh/uv/install.sh | bash
export PATH="/root/.local/bin:\$PATH"

# ── Firecracker + jailer ─────────────────────────────────────────────
ARCH=\$(uname -m)
FC_VERSION=\$(curl -s https://api.github.com/repos/firecracker-microvm/firecracker/releases/latest | jq -r '.tag_name')
cd /tmp
curl -LO "https://github.com/firecracker-microvm/firecracker/releases/download/\${FC_VERSION}/firecracker-\${FC_VERSION}-\${ARCH}.tgz"
tar xzf "firecracker-\${FC_VERSION}-\${ARCH}.tgz"
mv "release-\${FC_VERSION}-\${ARCH}/firecracker-\${FC_VERSION}-\${ARCH}" /usr/local/bin/firecracker
mv "release-\${FC_VERSION}-\${ARCH}/jailer-\${FC_VERSION}-\${ARCH}" /usr/local/bin/jailer
chmod +x /usr/local/bin/firecracker /usr/local/bin/jailer

# ── Kernel (vmlinux) from Firecracker CI S3 bucket ───────────────────
mkdir -p /opt/nightshift
cd /opt/nightshift

CI_VERSION=\$(echo "\$FC_VERSION" | sed 's/\.[0-9]*\$//')
latest_kernel_key=\$(curl -s "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/\${CI_VERSION}/\${ARCH}/vmlinux-&list-type=2" \
    | grep -oP "(?<=<Key>)(firecracker-ci/\${CI_VERSION}/\${ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" \
    | sort -V | tail -1)
wget -q -O vmlinux "https://s3.amazonaws.com/spec.ccfc.min/\${latest_kernel_key}"

# ── rootfs from GitHub Release ───────────────────────────────────────
curl -L -o rootfs.ext4.gz "https://github.com/${GITHUB_REPO}/releases/download/${VERSION}/rootfs.ext4.gz"
gunzip rootfs.ext4.gz

# ── Install nightshift from PyPI via uvx ─────────────────────────────
# uvx installs and runs CLI tools from PyPI in isolated environments.
# Pin to the release version so operator knows exactly what's running.
SDK_VERSION=\$(echo "${VERSION}" | sed 's/^v//')
uvx --from "nightshift-sdk==\${SDK_VERSION}" nightshift --version

# ── Caddy (auto-TLS reverse proxy) ──────────────────────────────────
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

cat > /etc/caddy/Caddyfile << 'CADDY'
${HOSTNAME} {
    reverse_proxy localhost:${PORT}
}
CADDY

# ── systemd service for nightshift serve ─────────────────────────────
cat > /etc/systemd/system/nightshift-serve.service << 'SYSTEMD'
[Unit]
Description=Nightshift Platform Server
After=network.target

[Service]
Type=simple
User=root
ExecStart=/root/.local/bin/uvx --from nightshift-sdk nightshift serve --port ${PORT}
Restart=on-failure
RestartSec=5
Environment=NIGHTSHIFT_API_KEY=${API_KEY}

[Install]
WantedBy=multi-user.target
SYSTEMD

# ── Enable and start services ────────────────────────────────────────
systemctl daemon-reload
systemctl enable --now nightshift-serve
systemctl enable caddy
systemctl reload caddy

# ── Done marker ──────────────────────────────────────────────────────
echo "setup_complete \$(date -u +%Y-%m-%dT%H:%M:%SZ)" > /opt/nightshift/.setup-done
USERDATA_EOF
)

# -------------------------------------------------------------------
# 5. Launch instance
# -------------------------------------------------------------------
echo "==> Launching $INSTANCE_TYPE instance..."
INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --region "$REGION" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":100,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --user-data "$USERDATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=nightshift},{Key=Project,Value=nightshift},{Key=Version,Value=$VERSION}]" \
    --query 'Instances[0].InstanceId' \
    --output text)
echo "    Instance ID: $INSTANCE_ID"

echo "==> Waiting for instance to enter 'running' state..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

# -------------------------------------------------------------------
# 6. Allocate and associate Elastic IP
# -------------------------------------------------------------------
echo "==> Allocating Elastic IP..."
ALLOC_ID=$(aws ec2 allocate-address \
    --domain vpc \
    --region "$REGION" \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=nightshift},{Key=Project,Value=nightshift}]" \
    --query 'AllocationId' \
    --output text)

ELASTIC_IP=$(aws ec2 describe-addresses \
    --allocation-ids "$ALLOC_ID" \
    --region "$REGION" \
    --query 'Addresses[0].PublicIp' \
    --output text)

aws ec2 associate-address \
    --instance-id "$INSTANCE_ID" \
    --allocation-id "$ALLOC_ID" \
    --region "$REGION" \
    --output text > /dev/null
echo "    Elastic IP: $ELASTIC_IP"

# -------------------------------------------------------------------
# 7. Save state
# -------------------------------------------------------------------
cat > "$STATE_FILE" << EOF
INSTANCE_ID=$INSTANCE_ID
ELASTIC_IP=$ELASTIC_IP
ALLOC_ID=$ALLOC_ID
KEY_PATH=~/.ssh/${KEY_NAME}.pem
REGION=$REGION
HOSTNAME=$HOSTNAME
VERSION=$VERSION
EOF
echo "    State saved to $STATE_FILE"

# -------------------------------------------------------------------
# 8. Wait for SSH
# -------------------------------------------------------------------
echo "==> Waiting for SSH..."
for i in $(seq 1 60); do
    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes \
        -i ~/.ssh/${KEY_NAME}.pem ubuntu@${ELASTIC_IP} "echo ok" &>/dev/null; then
        echo "    SSH is up"
        break
    fi
    if [ "$i" -eq 60 ]; then
        echo "    ERROR: SSH did not come up after 10 minutes"
        exit 1
    fi
    sleep 10
done

# -------------------------------------------------------------------
# 9. Wait for user-data setup to complete
# -------------------------------------------------------------------
echo "==> Waiting for instance setup to complete..."
echo "    (installing firecracker, kernel, rootfs, nightshift, caddy)"
for i in $(seq 1 90); do
    DONE=$(ssh -o StrictHostKeyChecking=no -i ~/.ssh/${KEY_NAME}.pem \
        ubuntu@${ELASTIC_IP} "cat /opt/nightshift/.setup-done 2>/dev/null" 2>/dev/null || echo "")
    if [ -n "$DONE" ]; then
        echo "    $DONE"
        break
    fi
    if [ "$i" -eq 90 ]; then
        echo "    ERROR: Setup did not complete after 15 minutes"
        echo "    Debug: ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@${ELASTIC_IP} 'tail -50 /var/log/nightshift-setup.log'"
        exit 1
    fi
    sleep 10
done

# -------------------------------------------------------------------
# 10. Print connection info
# -------------------------------------------------------------------
echo ""
echo "=== Nightshift deployment complete ==="
echo ""
echo "  Elastic IP: $ELASTIC_IP"
echo "  Server:     https://$HOSTNAME"
echo "  Health:     https://$HOSTNAME/health"
echo "  SSH:        ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@${ELASTIC_IP}"
echo "  Version:    $VERSION"
echo ""
echo "  DNS: Create an A record pointing $HOSTNAME to $ELASTIC_IP"
echo "       Caddy will automatically provision TLS once DNS propagates."
echo ""
echo "  Logs:    ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@${ELASTIC_IP} 'sudo journalctl -u nightshift-serve -f'"
echo "  Upgrade: ./infra/upgrade.sh ubuntu@${ELASTIC_IP} --key ~/.ssh/${KEY_NAME}.pem"
