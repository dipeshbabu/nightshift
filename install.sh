#!/bin/sh
set -e

# nightshift installer
# Usage: curl -fsSL https://raw.githubusercontent.com/nightshiftco/nightshift/main/install.sh | sh

REPO="nightshiftco/nightshift"
INSTALL_DIR="${NIGHTSHIFT_INSTALL_DIR:-$HOME/.nightshift/bin}"
BINARY_NAME="nightshift"

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

info() {
  printf "${BLUE}info${NC}: %s\n" "$1"
}

success() {
  printf "${GREEN}success${NC}: %s\n" "$1"
}

warn() {
  printf "${YELLOW}warn${NC}: %s\n" "$1"
}

error() {
  printf "${RED}error${NC}: %s\n" "$1" >&2
  exit 1
}

# Detect OS
detect_os() {
  case "$(uname -s)" in
    Darwin)
      echo "darwin"
      ;;
    Linux)
      echo "linux"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      echo "windows"
      ;;
    *)
      error "Unsupported operating system: $(uname -s)"
      ;;
  esac
}

# Detect architecture
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      echo "x64"
      ;;
    arm64|aarch64)
      echo "arm64"
      ;;
    *)
      error "Unsupported architecture: $(uname -m)"
      ;;
  esac
}

# Detect if running on musl libc (Alpine, etc.)
detect_musl() {
  if [ "$(detect_os)" = "linux" ]; then
    if ldd --version 2>&1 | grep -qi musl; then
      echo "musl"
    elif [ -f /etc/alpine-release ]; then
      echo "musl"
    fi
  fi
}

# Get latest release version from GitHub
get_latest_version() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/'
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/'
  else
    error "curl or wget is required"
  fi
}

# Download file
download() {
  url="$1"
  dest="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fSL --progress-bar -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q --show-progress -O "$dest" "$url"
  else
    error "curl or wget is required"
  fi
}

main() {
  info "Installing nightshift..."

  OS=$(detect_os)
  ARCH=$(detect_arch)
  MUSL=$(detect_musl)

  info "Detected platform: ${OS}-${ARCH}${MUSL:+-$MUSL}"

  # Build asset name
  if [ -n "$MUSL" ]; then
    ASSET_NAME="${BINARY_NAME}-${OS}-${ARCH}-${MUSL}.tar.gz"
  else
    ASSET_NAME="${BINARY_NAME}-${OS}-${ARCH}.tar.gz"
  fi

  # Get latest version
  info "Fetching latest release..."
  VERSION=$(get_latest_version)

  if [ -z "$VERSION" ]; then
    error "Failed to determine latest version"
  fi

  info "Latest version: ${VERSION}"

  # Download URL
  DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET_NAME}"

  # Create temp directory
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "$TMP_DIR"' EXIT

  ARCHIVE_PATH="${TMP_DIR}/${ASSET_NAME}"

  info "Downloading ${ASSET_NAME}..."
  download "$DOWNLOAD_URL" "$ARCHIVE_PATH"

  # Extract
  info "Extracting..."
  if [ "${ASSET_NAME%.zip}" != "$ASSET_NAME" ]; then
    unzip -q "$ARCHIVE_PATH" -d "$TMP_DIR"
  else
    tar xf "$ARCHIVE_PATH" -C "$TMP_DIR"
  fi

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  # Install binary
  EXTRACTED_BINARY="${TMP_DIR}/${BINARY_NAME}"
  if [ ! -f "$EXTRACTED_BINARY" ]; then
    error "Binary not found after extraction"
  fi

  mv "$EXTRACTED_BINARY" "${INSTALL_DIR}/${BINARY_NAME}"
  chmod +x "${INSTALL_DIR}/${BINARY_NAME}"

  success "Installed nightshift ${VERSION} to ${INSTALL_DIR}/${BINARY_NAME}"

  # Check if install dir is in PATH
  case ":$PATH:" in
    *":${INSTALL_DIR}:"*)
      ;;
    *)
      echo ""
      warn "${INSTALL_DIR} is not in your PATH"
      echo ""
      echo "Add it to your shell configuration:"
      echo ""

      SHELL_NAME=$(basename "$SHELL")
      case "$SHELL_NAME" in
        zsh)
          echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.zshrc"
          echo "  source ~/.zshrc"
          ;;
        bash)
          echo "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.bashrc"
          echo "  source ~/.bashrc"
          ;;
        fish)
          echo "  set -Ux fish_user_paths ${INSTALL_DIR} \$fish_user_paths"
          ;;
        *)
          echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
          ;;
      esac
      echo ""
      ;;
  esac

  echo "Run 'nightshift --help' to get started"
}

main "$@"
