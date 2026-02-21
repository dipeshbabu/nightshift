"""API key authentication for the platform server."""

from __future__ import annotations

import hashlib
import os
import secrets

from fastapi import Header, HTTPException

from nightshift.registry import AgentRegistry


def hash_api_key(key: str) -> str:
    """SHA-256 hash of an API key."""
    return hashlib.sha256(key.encode()).hexdigest()


def generate_api_key() -> str:
    """Generate a new API key in ns_<32 hex chars> format."""
    return f"ns_{secrets.token_hex(16)}"


async def bootstrap_api_key(registry: AgentRegistry) -> None:
    """Seed the first API key from NIGHTSHIFT_API_KEY env var if set.

    Idempotent — won't duplicate if the key already exists.
    """
    raw_key = os.environ.get("NIGHTSHIFT_API_KEY")
    if not raw_key:
        return

    key_hash = hash_api_key(raw_key)
    tenant_id = "default"
    await registry.store_api_key(key_hash, tenant_id, label="bootstrap")


async def get_tenant_id(
    registry: AgentRegistry,
    authorization: str = Header(),
) -> str:
    """Extract and verify the API key from the Authorization header.

    Expected format: 'Bearer ns_...'
    Returns the tenant_id if valid, raises 401 otherwise.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")

    token = authorization[7:]  # strip "Bearer "
    key_hash = hash_api_key(token)
    tenant_id = await registry.get_tenant_by_key_hash(key_hash)

    if tenant_id is None:
        raise HTTPException(status_code=401, detail="Invalid API key")

    return tenant_id
