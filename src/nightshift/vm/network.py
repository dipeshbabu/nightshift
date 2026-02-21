"""TAP device management for Firecracker VMs.

Each VM gets a unique TAP device and IP pair:
- Host side: 172.16.{vm_index}.1/30
- Guest side: 172.16.{vm_index}.2/30
- TAP device name: tap-{vm_id[:8]}
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

# Track allocated VM indices to avoid collisions
_allocated_indices: set[int] = set()
_index_lock = asyncio.Lock()


@dataclass
class TapConfig:
    tap_name: str
    host_ip: str
    guest_ip: str
    mask: str
    vm_index: int


async def _run(cmd: str) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_shell(
        cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return proc.returncode or 0, stdout.decode().strip(), stderr.decode().strip()


async def _allocate_index() -> int:
    async with _index_lock:
        idx = 1
        while idx in _allocated_indices:
            idx += 1
        _allocated_indices.add(idx)
        return idx


async def _release_index(idx: int) -> None:
    async with _index_lock:
        _allocated_indices.discard(idx)


async def create_tap(vm_id: str) -> TapConfig:
    """Create a TAP device, assign IPs, and set up NAT for a VM."""
    vm_index = await _allocate_index()
    tap_name = f"tap-{vm_id[:8]}"
    host_ip = f"172.16.{vm_index}.1"
    guest_ip = f"172.16.{vm_index}.2"
    mask = "255.255.255.252"  # /30 in dotted decimal for kernel ip= boot arg

    # Create TAP device
    await _run(f"ip tuntap add dev {tap_name} mode tap")
    await _run(f"ip addr add {host_ip}/{mask} dev {tap_name}")
    await _run(f"ip link set {tap_name} up")

    # Enable IP forwarding
    await _run("sysctl -w net.ipv4.ip_forward=1")

    # NAT masquerade for outbound internet access
    await _run(f"iptables -t nat -A POSTROUTING -s {guest_ip}/32 -j MASQUERADE")
    # Allow forwarding
    await _run(f"iptables -A FORWARD -i {tap_name} -j ACCEPT")
    await _run(f"iptables -A FORWARD -o {tap_name} -m state --state RELATED,ESTABLISHED -j ACCEPT")

    return TapConfig(
        tap_name=tap_name,
        host_ip=host_ip,
        guest_ip=guest_ip,
        mask=mask,
        vm_index=vm_index,
    )


async def destroy_tap(config: TapConfig) -> None:
    """Remove a TAP device and clean up iptables rules."""
    # Remove iptables rules
    await _run(f"iptables -t nat -D POSTROUTING -s {config.guest_ip}/32 -j MASQUERADE")
    await _run(f"iptables -D FORWARD -i {config.tap_name} -j ACCEPT")
    await _run(
        f"iptables -D FORWARD -o {config.tap_name} -m state --state RELATED,ESTABLISHED -j ACCEPT"
    )

    # Remove TAP device
    await _run(f"ip link del {config.tap_name}")

    await _release_index(config.vm_index)
