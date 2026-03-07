"""Serialize agent messages to JSON dicts for SSE transport."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, is_dataclass
from typing import Any


def _make_json_safe(obj: Any) -> Any:
    """Recursively convert non-JSON-serializable objects in a data structure."""
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return obj
    if isinstance(obj, dict):
        return {k: _make_json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_make_json_safe(item) for item in obj]
    if hasattr(obj, "model_dump_json"):
        return json.loads(obj.model_dump_json())
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json")
    if is_dataclass(obj) and not isinstance(obj, type):
        return _make_json_safe(asdict(obj))
    if hasattr(obj, "__dict__"):
        return _make_json_safe(vars(obj))
    return str(obj)


def serialize_message(message: Any) -> dict:
    """Convert an agent message to a JSON-serializable dict.

    Handles:
    - dicts (passed through with defaults)
    - dataclasses (converted via asdict, with nested pydantic models resolved)
    - pydantic models (converted via model_dump_json for full JSON safety)
    - objects with a __dict__ attribute
    """
    if isinstance(message, dict):
        data = dict(message)
    elif is_dataclass(message) and not isinstance(message, type):
        data = _make_json_safe(asdict(message))
    elif hasattr(message, "model_dump_json"):
        data = json.loads(message.model_dump_json())
    elif hasattr(message, "__dict__"):
        data = _make_json_safe(vars(message))
    else:
        data = {"data": str(message)}

    if "type" not in data:
        data["type"] = type(message).__name__

    if "timestamp" not in data:
        data["timestamp"] = time.time()

    return data
