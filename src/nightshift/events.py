"""Event types and in-memory event buffer.

EventBuffer replaces the previous EventLog/EventStore/EventSink stack
with a single class that stores events per run_id and supports async streaming.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from typing import AsyncIterator, Literal, Union

logger = logging.getLogger(__name__)


@dataclass
class BaseEvent:
    timestamp: float = field(default_factory=time.time)
    run_id: str | None = None


@dataclass
class StartedEvent(BaseEvent):
    type: Literal["nightshift.started"] = "nightshift.started"
    workspace: str = ""


@dataclass
class CompletedEvent(BaseEvent):
    type: Literal["nightshift.completed"] = "nightshift.completed"


@dataclass
class ErrorEvent(BaseEvent):
    type: Literal["nightshift.error"] = "nightshift.error"
    error: str = ""


@dataclass
class InterruptedEvent(BaseEvent):
    type: Literal["nightshift.interrupted"] = "nightshift.interrupted"
    reason: Literal["user_quit", "user_stop"] = "user_quit"


NightshiftEvent = Union[
    StartedEvent,
    CompletedEvent,
    ErrorEvent,
    InterruptedEvent,
]

TERMINAL_EVENTS = {"nightshift.completed", "nightshift.error", "nightshift.interrupted"}


class EventBuffer:
    """Simple in-memory event buffer with async streaming.

    Stores events per run_id and allows consumers to stream them
    (replay + live-tail) via an asyncio.Condition.
    """

    def __init__(self) -> None:
        self._runs: dict[str, list[tuple[str, dict]]] = {}
        self._cond: asyncio.Condition = asyncio.Condition()
        self._done: set[str] = set()

    async def append(self, run_id: str, event_type: str, payload: dict) -> None:
        """Append an event to a run's buffer and notify waiters."""
        self._runs.setdefault(run_id, []).append((event_type, payload))
        async with self._cond:
            self._cond.notify_all()

    async def stream(self, run_id: str, cursor: int = 0) -> AsyncIterator[tuple[str, dict]]:
        """Yield events for a run, replaying from cursor then live-tailing.

        Terminates when the run is marked done via cleanup().
        """
        while True:
            events = self._runs.get(run_id, [])
            while cursor < len(events):
                yield events[cursor]
                cursor += 1
            if run_id in self._done:
                return
            async with self._cond:
                await self._cond.wait()

    async def cleanup(self, run_id: str) -> None:
        """Mark a run as done so streaming consumers can finish.

        Events are kept in memory until explicitly reaped — this avoids
        a race where a fast run completes and deletes events before the
        SSE client has consumed them.
        """
        self._done.add(run_id)
        async with self._cond:
            self._cond.notify_all()

    def reap(self, run_id: str) -> None:
        """Free memory for a finished run. Call after consumers have disconnected."""
        self._runs.pop(run_id, None)
        self._done.discard(run_id)

    # ── Convenience methods (used by task.py, vm/manager.py, agent/entry.py) ──

    async def publish(self, run_id: str, event: NightshiftEvent) -> None:
        """Publish a typed NightshiftEvent."""
        event.run_id = run_id
        payload = asdict(event)
        event_type = payload.pop("type")
        await self.append(run_id, event_type, payload)

    async def publish_raw(self, run_id: str, event_type: str, data: dict) -> None:
        """Forward a raw event dict (e.g. from the guest SSE stream)."""
        payload = {k: v for k, v in data.items() if k != "type"}
        await self.append(run_id, event_type, payload)

    async def stream_sse(self, run_id: str) -> AsyncIterator[dict]:
        """Stream events formatted for SSE (event + data keys)."""
        async for event_type, payload in self.stream(run_id):
            yield {
                "event": event_type,
                "data": json.dumps({"type": event_type, **payload}),
            }
            if event_type in TERMINAL_EVENTS:
                return


# Backwards-compatible alias used by existing code
EventLog = EventBuffer
