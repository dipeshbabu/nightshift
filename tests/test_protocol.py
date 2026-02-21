"""Tests for the protocol module (events serialization, packaging)."""

import json
import os
import tempfile
from dataclasses import dataclass

from nightshift.protocol.events import serialize_message
from nightshift.protocol.packaging import cleanup_package, package_agent


# --- serialize_message tests ---


def test_serialize_dict():
    msg = {"type": "assistant", "content": "hello"}
    result = serialize_message(msg)
    assert result["type"] == "assistant"
    assert result["content"] == "hello"
    assert "timestamp" in result


def test_serialize_dict_adds_default_type():
    msg = {"content": "hello"}
    result = serialize_message(msg)
    assert result["type"] == "dict"
    assert result["content"] == "hello"


@dataclass
class FakeMessage:
    type: str = "test"
    content: str = ""


def test_serialize_dataclass():
    msg = FakeMessage(type="result", content="done")
    result = serialize_message(msg)
    assert result["type"] == "result"
    assert result["content"] == "done"
    assert "timestamp" in result


def test_serialize_plain_object():
    class Obj:
        def __init__(self):
            self.type = "custom"
            self.data = 42

    result = serialize_message(Obj())
    assert result["type"] == "custom"
    assert result["data"] == 42


def test_serialize_string_fallback():
    result = serialize_message("just a string")
    assert result["data"] == "just a string"
    assert result["type"] == "str"


# --- package_agent tests ---


def test_package_agent_creates_manifest():
    # Create a temp source file
    with tempfile.NamedTemporaryFile(suffix=".py", mode="w", delete=False) as f:
        f.write("async def my_agent(prompt): yield {'type': 'result'}\n")
        source_path = f.name

    try:
        pkg_dir = package_agent(source_path, "my_agent", "Fix the bug")
        try:
            # Check manifest
            manifest_path = os.path.join(pkg_dir, "manifest.json")
            assert os.path.exists(manifest_path)
            with open(manifest_path) as f:
                manifest = json.load(f)
            assert manifest["function"] == "my_agent"
            assert manifest["prompt"] == "Fix the bug"
            assert manifest["module"] == os.path.splitext(os.path.basename(source_path))[0]

            # Check source file was copied
            source_copy = os.path.join(pkg_dir, os.path.basename(source_path))
            assert os.path.exists(source_copy)
        finally:
            cleanup_package(pkg_dir)
            assert not os.path.exists(pkg_dir)
    finally:
        os.unlink(source_path)


def test_package_agent_detects_pyproject():
    """package_agent copies pyproject.toml and uv.lock when found."""
    with tempfile.TemporaryDirectory() as project_dir:
        # Write a pyproject.toml in the project root
        pyproject = os.path.join(project_dir, "pyproject.toml")
        with open(pyproject, "w") as f:
            f.write('[project]\nname = "my-agent"\ndependencies = ["claude-agent-sdk"]\n')

        # Write a uv.lock alongside it
        lock = os.path.join(project_dir, "uv.lock")
        with open(lock, "w") as f:
            f.write("# lock content\n")

        # Write agent source in a subdirectory
        src_dir = os.path.join(project_dir, "src")
        os.makedirs(src_dir)
        agent_file = os.path.join(src_dir, "my_agent.py")
        with open(agent_file, "w") as f:
            f.write("async def run(prompt): yield {'type': 'result'}\n")

        pkg_dir = package_agent(agent_file, "run", "test prompt")
        try:
            # pyproject.toml should be copied
            assert os.path.exists(os.path.join(pkg_dir, "pyproject.toml"))
            # uv.lock should be copied
            assert os.path.exists(os.path.join(pkg_dir, "uv.lock"))
            # manifest should flag has_pyproject
            with open(os.path.join(pkg_dir, "manifest.json")) as f:
                manifest = json.load(f)
            assert manifest["has_pyproject"] is True
        finally:
            cleanup_package(pkg_dir)


def test_package_agent_no_pyproject():
    """package_agent works without a pyproject.toml (has_pyproject=False)."""
    with tempfile.NamedTemporaryFile(
        suffix=".py", mode="w", delete=False, dir="/tmp"
    ) as f:
        f.write("async def run(prompt): yield {'type': 'result'}\n")
        source_path = f.name

    try:
        pkg_dir = package_agent(source_path, "run", "test")
        try:
            assert not os.path.exists(os.path.join(pkg_dir, "pyproject.toml"))
            with open(os.path.join(pkg_dir, "manifest.json")) as f:
                manifest = json.load(f)
            assert manifest["has_pyproject"] is False
        finally:
            cleanup_package(pkg_dir)
    finally:
        os.unlink(source_path)


def test_cleanup_package_idempotent():
    pkg_dir = tempfile.mkdtemp()
    cleanup_package(pkg_dir)
    # Second call should not raise
    cleanup_package(pkg_dir)
