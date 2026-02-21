"""CLI config — reads/writes ~/.nightshift/config.toml."""

from __future__ import annotations

import os
import stat
import tomllib

import tomli_w


CONFIG_DIR = os.path.expanduser("~/.nightshift")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.toml")


def load_config() -> dict:
    """Load the CLI config file, returning {} if it doesn't exist."""
    if not os.path.exists(CONFIG_PATH):
        return {}
    with open(CONFIG_PATH, "rb") as f:
        return tomllib.load(f)


def save_config(data: dict) -> None:
    """Write the CLI config file with restricted permissions (0600)."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_PATH, "wb") as f:
        tomli_w.dump(data, f)
    os.chmod(CONFIG_PATH, stat.S_IRUSR | stat.S_IWUSR)


def get_url() -> str:
    """Get the platform URL from config."""
    cfg = load_config()
    url = cfg.get("url", "")
    if not url:
        raise SystemExit("Not logged in. Run: nightshift login --url <URL> --api-key <KEY>")
    return url


def get_api_key() -> str:
    """Get the API key from config."""
    cfg = load_config()
    key = cfg.get("api_key", "")
    if not key:
        raise SystemExit("Not logged in. Run: nightshift login --url <URL> --api-key <KEY>")
    return key


def get_auth_headers() -> dict[str, str]:
    """Get Authorization headers for API requests."""
    return {"Authorization": f"Bearer {get_api_key()}"}
