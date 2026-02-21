"""Serialize Claude Agent SDK messages to JSON dicts for SSE transport."""

from __future__ import annotations

import time
from dataclasses import asdict, is_dataclass
from typing import Any


def serialize_message(message: Any) -> dict:
    """Convert an agent message to a JSON-serializable dict.

    Handles:
    - dicts (passed through with defaults)
    - dataclasses (converted via asdict)
    - pydantic models (converted via model_dump)
    - objects with a __dict__ attribute
    """
    if isinstance(message, dict):
        data = dict(message)
    elif is_dataclass(message) and not isinstance(message, type):
        data = asdict(message)
    elif hasattr(message, "model_dump"):
        data = message.model_dump()
    elif hasattr(message, "__dict__"):
        data = dict(message.__dict__)
    else:
        data = {"data": str(message)}

    if "type" not in data:
        data["type"] = type(message).__name__

    if "timestamp" not in data:
        data["timestamp"] = time.time()

    return data
