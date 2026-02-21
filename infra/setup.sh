#!/bin/bash
#
# Stand up a c5.metal bare-metal EC2 instance for Firecracker VM testing.
#
# Firecracker requires /dev/kvm (hardware virtualization). On AWS, KVM is
# only exposed on .metal instance types. c5.metal gives us 96 vCPUs and
# 192 GiB RAM — the Firecracker docs recommend it. Costs ~$4.08/hr.
#
# -- Creates an SSH key pair (or reuses an existing one)
# -- Creates/updates a security group locked to your current IP
# -- Finds the latest Ubuntu 22.04 AMI
# -- Launches the instance with a user-data script that installs:
#    - Firecracker + jailer 
#    - A Linux kernel image 
#    - An Ubuntu rootfs 
#    - uv (Python package manager)
#    - Neovim (latest stable from GitHub releases)
#    - Neovim config (cloned from tensor-ninja/nvim)
#    - Node.js 22 LTS + Claude Code
#    - KVM access for the ubuntu user
# --Waits for SSH and the user-data setup to finish
# --Saves instance details to infra/.instance for test.sh and teardown.sh
#
# Usage:
#   ./infra/setup.sh
#   ./infra/setup.sh --production --hostname api.nightshift.sh
#
set -euo pipefail

# Resolve paths relative to this script so it works from any directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# All three scripts (setup, test, teardown) share state through this file.
# It stores INSTANCE_ID, PUBLIC_IP, KEY_PATH, and REGION.
STATE_FILE="$SCRIPT_DIR/.instance"

INSTANCE_TYPE="c5.metal"
KEY_NAME="nightshift-dev"
SG_NAME="nightshift-dev"
PRODUCTION=false
PROD_HOSTNAME=""
PROD_PORT=3000

# Parse optional flags
while [[ $# -gt 0 ]]; do
    case $1 in
        --production) PRODUCTION=true; shift ;;
        --hostname)   PROD_HOSTNAME="$2"; shift 2 ;;
        --port)       PROD_PORT="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

if [ "$PRODUCTION" = true ] && [ -z "$PROD_HOSTNAME" ]; then
    echo "Error: --production requires --hostname"
    echo "Usage: $0 --production --hostname <FQDN> [--port <port>]"
    exit 1
fi

# Default to us-east-1 but respect AWS_DEFAULT_REGION if set.
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "==> Nightshift dev environment setup"
echo "    Instance type: $INSTANCE_TYPE"
echo "    Region: $REGION"
echo ""

# AWS EC2 instances authenticate via key pairs. We check if one already exists
# in AWS; if not, we create one and save the private key to ~/.ssh/.
#
# The private key MUST be on disk — if the key pair exists in AWS but the .pem
# file is missing locally, we can't SSH in, so we abort.

if ! aws ec2 describe-key-pairs --key-names "$KEY_NAME" --region "$REGION" &>/dev/null; then
    echo "==> Creating key pair: $KEY_NAME"

    # --query 'KeyMaterial' extracts just the PEM-encoded private key from the
    # JSON response, and --output text gives us raw text 
    aws ec2 create-key-pair \
        --key-name "$KEY_NAME" \
        --region "$REGION" \
        --query 'KeyMaterial' \
        --output text > ~/.ssh/${KEY_NAME}.pem

    # SSH requires private keys to be readable only by the owner.
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

#
# Security groups are AWS firewalls. We create one that only allows SSH 
# from your current public IP. This is safer than opening SSH to 0.0.0.0/0.
#
# On re-runs, we remove any stale IP rules and add your current IP, so if your
# IP changes between sessions, just re-run setup.sh.

SG_ID=$(aws ec2 describe-security-groups \
    --filters "Name=group-name,Values=$SG_NAME" \
    --region "$REGION" \
    --query 'SecurityGroups[0].GroupId' \
    --output text 2>/dev/null || echo "None")

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
    echo "==> Creating security group: $SG_NAME"
    SG_ID=$(aws ec2 create-security-group \
        --group-name "$SG_NAME" \
        --description "Nightshift dev instance — SSH only" \
        --region "$REGION" \
        --query 'GroupId' \
        --output text)
fi

# detect our current public IP using AWS's checkip service.
MY_IP=$(curl -s https://checkip.amazonaws.com)
echo "==> Updating SSH access to $MY_IP"

# remove all existing SSH (port 22) ingress rules so we don't accumulate stale IPs.
# the JMESPath query extracts all CIDR blocks that have FromPort==22.
OLD_RULES=$(aws ec2 describe-security-groups \
    --group-ids "$SG_ID" \
    --region "$REGION" \
    --query 'SecurityGroups[0].IpPermissions[?FromPort==`22`].IpRanges[].CidrIp' \
    --output text 2>/dev/null || echo "")

for cidr in $OLD_RULES; do
    # revoke-security-group-ingress removes a single inbound rule.
    aws ec2 revoke-security-group-ingress \
        --group-id "$SG_ID" \
        --protocol tcp --port 22 --cidr "$cidr" \
        --region "$REGION" &>/dev/null || true
done

# add our current IP. The /32 suffix means "this single IP only".
aws ec2 authorize-security-group-ingress \
    --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr "${MY_IP}/32" \
    --region "$REGION" &>/dev/null
echo "    Security group: $SG_ID"

# When deploying for production, open ports 80 and 443 for Caddy's auto-TLS.
if [ "$PRODUCTION" = true ]; then
    echo "==> Opening ports 80/443 for production TLS"
    aws ec2 authorize-security-group-ingress \
        --group-id "$SG_ID" \
        --protocol tcp --port 80 --cidr "0.0.0.0/0" \
        --region "$REGION" &>/dev/null || true
    aws ec2 authorize-security-group-ingress \
        --group-id "$SG_ID" \
        --protocol tcp --port 443 --cidr "0.0.0.0/0" \
        --region "$REGION" &>/dev/null || true
fi

#
# Find the latest Ubuntu 22.04 (Jammy) HVM SSD AMI published by Canonical.
#   - Owner 099720109477 is Canonical's official AWS account.
#   - We sort by CreationDate and take the last (newest) one.
#   - Firecracker needs a modern kernel (5.10+), and 22.04 ships with 5.15+.

AMI_ID=$(aws ec2 describe-images \
    --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
              "Name=state,Values=available" \
    --region "$REGION" \
    --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
    --output text)
echo "==> AMI: $AMI_ID (Ubuntu 22.04 latest)"

#
# EC2 "user data" is a script that runs as root on first boot. We use it to
# install everything the instance needs so it's ready to run Firecracker VMs
# by the time we SSH in.
#
# The script logs everything to /var/log/nightshift-setup.log and writes a
# marker file /opt/nightshift/.setup-done when complete — we poll for that
# marker below.

USERDATA=$(cat << 'USERDATA_EOF'
#!/bin/bash
set -euxo pipefail

# Tee all output to a log file so we can debug setup failures.
exec > >(tee /var/log/nightshift-setup.log) 2>&1

# System packages 
# git, curl, wget, jq: general utilities
# build-essential: C compiler (needed by some Python packages)
# acl: setfacl command for /dev/kvm permissions
# iptables, iproute2: networking for Firecracker TAP devices
# rsync: used to copy workspaces in/out of VM rootfs images
apt-get update
apt-get upgrade -y
apt-get install -y git curl wget jq build-essential acl iptables iproute2 rsync

# KVM access 
# Firecracker uses KVM (/dev/kvm) for hardware-accelerated virtualization.
# On c5.metal, the kvm_intel module provides this.
# We grant the ubuntu user read/write access via POSIX ACLs (setfacl),
# and write a udev rule so the permission persists across reboots.
modprobe kvm
modprobe kvm_intel 2>/dev/null || modprobe kvm_amd 2>/dev/null || true
setfacl -m u:ubuntu:rw /dev/kvm 2>/dev/null || chmod 666 /dev/kvm
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' > /etc/udev/rules.d/99-kvm.rules

# uv 
# Installed under the ubuntu user's home so it's available without root.
# uv manages Python versions, virtualenvs, and package installs.
curl -LsSf https://astral.sh/uv/install.sh | sudo -u ubuntu bash
echo 'export PATH="/home/ubuntu/.local/bin:$PATH"' >> /home/ubuntu/.bashrc

# Firecracker 
# Download the latest release tarball from GitHub. The tarball contains
# two binaries:
#   - firecracker: the VMM (virtual machine monitor) that boots microVMs
#   - jailer: optional security wrapper that runs firecracker in a chroot
# We install both to /usr/local/bin.
ARCH=$(uname -m)
FC_VERSION=$(curl -s https://api.github.com/repos/firecracker-microvm/firecracker/releases/latest | jq -r '.tag_name')
cd /tmp
curl -LO "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz"
tar xzf "firecracker-${FC_VERSION}-${ARCH}.tgz"
mv "release-${FC_VERSION}-${ARCH}/firecracker-${FC_VERSION}-${ARCH}" /usr/local/bin/firecracker
mv "release-${FC_VERSION}-${ARCH}/jailer-${FC_VERSION}-${ARCH}" /usr/local/bin/jailer
chmod +x /usr/local/bin/firecracker /usr/local/bin/jailer

# Kernel + rootfs 
# Firecracker boots a Linux kernel directly (no bootloader). We download a
# pre-built kernel (vmlinux) from Firecracker's CI S3 bucket.
#
# The rootfs is a filesystem image that the VM uses as its root disk.
# Firecracker CI publishes Ubuntu images as squashfs (read-only compressed).
# We convert it to ext4 (read-write) because our VMs need to write files.
#
# Files are stored at /opt/nightshift/:
#   - vmlinux: the kernel binary (ELF executable, ~43MB)
#   - rootfs.ext4: the root filesystem image (2GB sparse ext4)
mkdir -p /opt/nightshift
cd /opt/nightshift

# The CI bucket organizes artifacts by major.minor version (e.g., v1.14).
# We strip the patch version from the full release tag to get the CI prefix.
CI_VERSION=$(echo "$FC_VERSION" | sed 's/\.[0-9]*$//')

# Query the S3 bucket listing (XML) to find the latest kernel for our arch.
# grep -oP extracts the S3 key using a positive lookbehind for <Key> tags.
# sort -V does version sorting so we pick the highest kernel version.
latest_kernel_key=$(curl -s "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/${ARCH}/vmlinux-&list-type=2" \
    | grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/${ARCH}/vmlinux-[0-9]+\.[0-9]+\.[0-9]{1,3})(?=</Key>)" \
    | sort -V | tail -1)
wget -q -O vmlinux "https://s3.amazonaws.com/spec.ccfc.min/${latest_kernel_key}"

# Same approach for the Ubuntu rootfs squashfs image.
latest_rootfs_key=$(curl -s "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/${CI_VERSION}/${ARCH}/ubuntu-&list-type=2" \
    | grep -oP "(?<=<Key>)(firecracker-ci/${CI_VERSION}/${ARCH}/ubuntu-[0-9]+\.[0-9]+\.squashfs)(?=</Key>)" \
    | sort -V | tail -1)
wget -q -O rootfs.squashfs "https://s3.amazonaws.com/spec.ccfc.min/${latest_rootfs_key}"

# Convert squashfs (read-only) to ext4 (read-write):
# 1. unsquashfs extracts the compressed image to a directory
# 2. dd creates a 2GB sparse file (only uses disk space for actual data)
# 3. mkfs.ext4 formats it as ext4
# 4. We mount it, copy the extracted files in, then unmount
apt-get install -y squashfs-tools
unsquashfs -d /tmp/rootfs-contents rootfs.squashfs
dd if=/dev/zero of=rootfs.ext4 bs=1M count=0 seek=2048
mkfs.ext4 -F rootfs.ext4
mkdir -p /tmp/rootfs-mount
mount -o loop rootfs.ext4 /tmp/rootfs-mount
cp -a /tmp/rootfs-contents/* /tmp/rootfs-mount/
umount /tmp/rootfs-mount
rm -rf /tmp/rootfs-contents /tmp/rootfs-mount rootfs.squashfs
chown -R ubuntu:ubuntu /opt/nightshift

# Neovim
# Ubuntu 22.04 ships neovim 0.6.x which is too old for most modern configs.
# Download the latest stable release tarball from GitHub instead.
curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.tar.gz
tar xzf nvim-linux-x86_64.tar.gz
mv nvim-linux-x86_64 /opt/nvim
ln -s /opt/nvim/bin/nvim /usr/local/bin/nvim
rm nvim-linux-x86_64.tar.gz

# Neovim config
# Clone the user's config repo into the standard XDG config path.
# Run as ubuntu so file ownership is correct and plugins install cleanly.
sudo -u ubuntu mkdir -p /home/ubuntu/.config
sudo -u ubuntu git clone https://github.com/tensor-ninja/nvim /home/ubuntu/.config/nvim

# Claude Code
# Requires Node.js >= 18. Install Node 22 LTS from NodeSource, then install
# Claude Code globally so it's available as `claude` on the PATH.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g @anthropic-ai/claude-code

# IP forwarding
# Firecracker VMs communicate over TAP devices with private IPs (172.16.x.x).
# IP forwarding lets the host route packets between the VM and the internet,
# which the VM needs for API calls to LLM providers.
echo 'net.ipv4.ip_forward = 1' > /etc/sysctl.d/99-firecracker.conf
sysctl -p /etc/sysctl.d/99-firecracker.conf

# Done marker
# The setup script on the host polls for this file to know when to proceed.
echo "setup_complete $(date -u +%Y-%m-%dT%H:%M:%SZ)" > /opt/nightshift/.setup-done
USERDATA_EOF
)

#
# aws ec2 run-instances launches the instance. Key flags:
#   --image-id: the Ubuntu 22.04 AMI we found above
#   --instance-type: c5.metal (bare-metal, KVM-capable)
#   --key-name: SSH key pair for authentication
#   --security-group-ids: firewall rules (SSH from our IP only)
#   --block-device-mappings: 100GB gp3 root volume (deleted on termination)
#   --user-data: the bootstrap script that runs on first boot
#   --tag-specifications: Name tag for the EC2 console

echo "==> Launching $INSTANCE_TYPE instance..."
INSTANCE_ID=$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --region "$REGION" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":100,"VolumeType":"gp3","DeleteOnTermination":true}}]' \
    --user-data "$USERDATA" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=nightshift-dev},{Key=Project,Value=nightshift}]" \
    --query 'Instances[0].InstanceId' \
    --output text)
echo "    Instance ID: $INSTANCE_ID"

#
# "instance-running" means the hypervisor has started the instance, but
# user-data hasn't finished yet. Metal instances take 3-5 minutes to boot
# (longer than virtualized instances).

echo "==> Waiting for instance to enter 'running' state..."
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID" --region "$REGION"

# Grab the public IP assigned by AWS. We need this to SSH in.
PUBLIC_IP=$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' \
    --output text)
echo "    Public IP: $PUBLIC_IP"

#
# Write instance details to a file that test.sh and teardown.sh source.
# This avoids hardcoding IPs or instance IDs in any script.

cat > "$STATE_FILE" << EOF
INSTANCE_ID=$INSTANCE_ID
PUBLIC_IP=$PUBLIC_IP
KEY_PATH=~/.ssh/${KEY_NAME}.pem
REGION=$REGION
EOF
echo "    State saved to $STATE_FILE"

#
# Even after the instance is "running", sshd may not be ready yet.
# We poll every 10 seconds for up to 10 minutes.
#   -o ConnectTimeout=5: give up after 5s per attempt
#   -o StrictHostKeyChecking=no: accept the host key automatically
#   -o BatchMode=yes: don't prompt for passwords (fail immediately if key auth fails)

echo "==> Waiting for SSH..."
for i in $(seq 1 60); do
    if ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes \
        -i ~/.ssh/${KEY_NAME}.pem ubuntu@${PUBLIC_IP} "echo ok" &>/dev/null; then
        echo "    SSH is up"
        break
    fi
    if [ "$i" -eq 60 ]; then
        echo "    ERROR: SSH did not come up after 10 minutes"
        exit 1
    fi
    sleep 10
done

#
# The user-data script runs in the background after boot. It writes a marker
# file at /opt/nightshift/.setup-done when all installs are complete.
# We SSH in and poll for that file every 10 seconds.

echo "==> Waiting for instance setup to complete (firecracker, kernel, rootfs)..."
for i in $(seq 1 60); do
    DONE=$(ssh -o StrictHostKeyChecking=no -i ~/.ssh/${KEY_NAME}.pem \
        ubuntu@${PUBLIC_IP} "cat /opt/nightshift/.setup-done 2>/dev/null" 2>/dev/null || echo "")
    if [ -n "$DONE" ]; then
        echo "    $DONE"
        break
    fi
    if [ "$i" -eq 60 ]; then
        echo "    ERROR: Setup did not complete after 10 minutes"
        echo "    Debug: ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@${PUBLIC_IP} 'tail -50 /var/log/nightshift-setup.log'"
        exit 1
    fi
    sleep 10
done

#
# When --production is set, sync the project and run production.sh on the
# remote instance. This installs Caddy, creates systemd services, and starts
# everything. We do this over SSH rather than in user-data to avoid fragile
# heredoc-in-heredoc variable expansion issues.

if [ "$PRODUCTION" = true ]; then
    echo "==> Syncing project to instance..."
    rsync -az --exclude '.git' --exclude '__pycache__' --exclude '.venv' \
        -e "ssh -o StrictHostKeyChecking=no -i ~/.ssh/${KEY_NAME}.pem" \
        "$(dirname "$SCRIPT_DIR")/" "ubuntu@${PUBLIC_IP}:/home/ubuntu/nightshift/"

    echo "==> Running production deployment on instance..."
    ssh -o StrictHostKeyChecking=no -i ~/.ssh/${KEY_NAME}.pem "ubuntu@${PUBLIC_IP}" \
        "cd /home/ubuntu/nightshift && ./infra/production.sh --hostname $PROD_HOSTNAME --port $PROD_PORT"

    echo ""
    echo "=== Production instance ready ==="
    echo "  Server:  https://$PROD_HOSTNAME"
    echo "  Health:  https://$PROD_HOSTNAME/health"
    echo "  SSH:     ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@${PUBLIC_IP}"
else
    echo ""
    echo "=== Instance ready ==="
    echo "  ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@${PUBLIC_IP}"
    echo ""
    echo "  Next: ./infra/test.sh"
    echo "  Done: ./infra/teardown.sh"
fi
