"""Tests for EventBuffer (the simplified event system)."""

import asyncio

import pytest

from nightshift.events import (
    CompletedEvent,
    ErrorEvent,
    EventBuffer,
    StartedEvent,
)


@pytest.mark.asyncio
async def test_event_buffer_publish_and_stream_replay():
    """Publish 3 events then stream — all 3 are replayed."""
    buf = EventBuffer()
    await buf.publish("run-1", StartedEvent(workspace="/test"))
    await buf.publish_raw("run-1", "agent.message", {"type": "agent.message", "text": "hi"})
    await buf.publish("run-1", CompletedEvent())

    events = []
    async for event in buf.stream_sse("run-1"):
        events.append(event)

    assert len(events) == 3
    assert events[0]["event"] == "nightshift.started"
    assert events[1]["event"] == "agent.message"
    assert events[2]["event"] == "nightshift.completed"


@pytest.mark.asyncio
async def test_event_buffer_stream_terminates_on_error():
    """Stream stops on nightshift.error."""
    buf = EventBuffer()
    await buf.publish("run-1", StartedEvent(workspace="/test"))
    await buf.publish("run-1", ErrorEvent(error="boom"))
    await buf.publish_raw("run-1", "agent.message", {"type": "agent.message", "text": "hi"})

    events = []
    async for event in buf.stream_sse("run-1"):
        events.append(event)

    assert len(events) == 2
    assert events[-1]["event"] == "nightshift.error"


@pytest.mark.asyncio
async def test_event_buffer_stream_live_tail():
    """Start stream, then publish — events arrive via live tail."""
    buf = EventBuffer()
    received = []

    async def consumer():
        async for event in buf.stream_sse("run-1"):
            received.append(event)

    task = asyncio.create_task(consumer())

    # Give consumer time to start and hit the wait
    await asyncio.sleep(0.05)

    await buf.publish("run-1", StartedEvent(workspace="/test"))
    await asyncio.sleep(0.05)
    await buf.publish("run-1", CompletedEvent())

    # Wait for stream to terminate on the terminal event
    await asyncio.wait_for(task, timeout=2.0)

    assert len(received) == 2
    assert received[0]["event"] == "nightshift.started"
    assert received[1]["event"] == "nightshift.completed"


@pytest.mark.asyncio
async def test_event_buffer_isolation_between_runs():
    """Events for different run_ids don't cross."""
    buf = EventBuffer()
    await buf.publish("run-a", StartedEvent(workspace="/a"))
    await buf.publish("run-b", StartedEvent(workspace="/b"))
    await buf.publish("run-a", CompletedEvent())
    await buf.publish("run-b", CompletedEvent())

    events_a = []
    async for event in buf.stream_sse("run-a"):
        events_a.append(event)

    events_b = []
    async for event in buf.stream_sse("run-b"):
        events_b.append(event)

    assert len(events_a) == 2
    assert len(events_b) == 2
    assert '"workspace": "/a"' in events_a[0]["data"]
    assert '"workspace": "/b"' in events_b[0]["data"]


@pytest.mark.asyncio
async def test_event_buffer_cleanup():
    """cleanup() removes the run's events."""
    buf = EventBuffer()
    await buf.publish("run-1", StartedEvent(workspace="/test"))
    await buf.publish("run-1", CompletedEvent())

    await buf.cleanup("run-1")
    assert "run-1" not in buf._runs


@pytest.mark.asyncio
async def test_event_buffer_append_and_stream_raw():
    """Low-level append + stream works correctly."""
    buf = EventBuffer()
    await buf.append("run-1", "nightshift.started", {"workspace": "/a"})
    await buf.append("run-1", "agent.message", {"text": "hello"})
    await buf.append("run-1", "nightshift.completed", {})

    collected = []
    async for event_type, payload in buf.stream("run-1"):
        collected.append((event_type, payload))
        if len(collected) == 3:
            break

    assert len(collected) == 3
    assert collected[0][0] == "nightshift.started"
    assert collected[1][0] == "agent.message"
    assert collected[2][0] == "nightshift.completed"


@pytest.mark.asyncio
async def test_event_buffer_stream_terminates_on_cleanup():
    """Stream exits cleanly when the run is cleaned up."""
    buf = EventBuffer()
    await buf.append("run-1", "nightshift.started", {})

    collected = []

    async def consumer():
        async for event_type, payload in buf.stream("run-1"):
            collected.append((event_type, payload))

    task = asyncio.create_task(consumer())
    await asyncio.sleep(0.05)

    await buf.cleanup("run-1")

    await asyncio.wait_for(task, timeout=2.0)
    assert len(collected) == 1
    assert collected[0][0] == "nightshift.started"
