"""Firecracker VM lifecycle management.

Handles creating, starting, monitoring, and destroying Firecracker microVMs.
Each VM runs an isolated agent that communicates via an HTTP /events endpoint.

Architecture overview:
    Host (nightshift)
        └── FirecrackerVM
                ├── Overlay rootfs (copy-on-write layer over base image)
                ├── TAP network device (host <-> guest communication)
                └── Guest agent (exposes /health + /events SSE endpoints)

The host orchestrates the VM via Firecracker's Unix-socket API, then
monitors task progress by consuming Server-Sent Events (SSE) from the
guest agent running inside the VM.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from dataclasses import dataclass, field

import httpx
from httpx_sse import aconnect_sse

from nightshift.events import TERMINAL_EVENTS, EventLog
from nightshift.vm.network import TapConfig, create_tap, destroy_tap
from nightshift.vm.rootfs import copy_workspace_out, create_overlay, destroy_overlay


@dataclass
class VMConfig:
    """Static configuration for a Firecracker VM instance.

    These values are set once before the VM boots and cannot be changed
    while the VM is running.
    """

    # Path to the uncompressed Linux kernel binary (vmlinux) that Firecracker loads directly.
    kernel_path: str

    # Path to the base ext4 rootfs image. An overlay is created on top of this
    # so the original image is never modified — multiple VMs can share the same base.
    base_rootfs_path: str

    # Host directory that gets copied INTO the overlay rootfs before boot,
    # giving the guest agent access to the project files it needs to work on.
    workspace_path: str

    # Host directory containing the packaged agent code. Copied into the
    # overlay at /opt/nightshift/agent_pkg so the agent source is separate
    # from the user's workspace.
    agent_pkg_path: str = ""

    # Environment variables injected into the guest rootfs (written to /etc/environment).
    # Typically includes API keys and config the guest agent needs at runtime.
    env_vars: dict[str, str] = field(default_factory=dict)

    # Number of virtual CPUs allocated to this VM.
    vcpu_count: int = 2

    # RAM allocated to this VM in MiB.
    mem_size_mib: int = 2048

    # The port the guest agent listens on inside the VM.
    # The host reaches it via the TAP network at http://<guest_ip>:<event_port>.
    event_port: int = 8080

    # Maximum seconds to wait for the guest agent's /health endpoint to respond
    # before considering the VM boot a failure. Polled at 0.5s intervals,
    # so the actual number of attempts is health_timeout * 2.
    health_timeout: int = 60


class FirecrackerVM:
    """Manages a single Firecracker VM lifecycle.

    Lifecycle:
        1. start()                – provisions resources and boots the VM
        2. wait_for_completion()  – streams SSE events until the agent finishes
        3. copy_workspace_out()   – gracefully shuts down the VM and extracts results
        4. destroy()              – tears down all remaining resources

    Each step must be called in order; skipping steps may leak resources.
    """

    def __init__(self, vm_id: str, config: VMConfig) -> None:
        self.vm_id = vm_id
        self.config = config

        # --- Runtime state (populated during start(), cleaned up in destroy()) ---

        # The firecracker child process handle. Used to monitor liveness and send kill.
        self._proc: asyncio.subprocess.Process | None = None

        # Path to the Unix domain socket for Firecracker's REST API.
        # All VM configuration (boot source, drives, network, machine config)
        # is sent here via HTTP PUT over UDS before the instance is started.
        self._socket_path: str = ""

        # Path to the copy-on-write overlay rootfs image file.
        # This is the actual drive attached to the VM — the base image stays untouched.
        self._overlay_path: str = ""

        # TAP network configuration (host IP, guest IP, tap device name, subnet mask).
        # Created before boot and torn down in destroy().
        self._tap: TapConfig | None = None

        # Temporary directory that holds the overlay image and the API socket file.
        # Cleaned up entirely in destroy() via shutil.rmtree.
        self._overlay_dir: str = ""

    @property
    def guest_url(self) -> str:
        """Base URL to reach the guest agent's HTTP server over the TAP network.

        Only valid after start() has completed. The guest agent inside the VM
        binds to 0.0.0.0:<event_port>, and we reach it from the host via the
        guest's TAP IP address.
        """
        if not self._tap:
            raise RuntimeError("VM not started")
        return f"http://{self._tap.guest_ip}:{self.config.event_port}"

    async def start(self) -> None:
        """Boot the VM through the full Firecracker provisioning sequence.
        1. Create a temp directory for this VM's ephemeral files.
        2. Build an overlay rootfs (workspace + env vars baked in).
        3. Create a TAP network device for host <-> guest connectivity.
        4. Spawn the firecracker process (it exposes a REST API on a Unix socket).
        5. Wait for the API socket file to appear on disk.
        6. Configure the VM via sequential PUT requests:
           a. /boot-source    – kernel image + boot args (including static IP config)
           b. /drives/rootfs  – attach the overlay rootfs as the root block device
           c. /network-interfaces/eth0 – attach the TAP device with a generated MAC
           d. /machine-config – set vCPU count and memory size
        7. Issue InstanceStart action to boot the guest kernel.
        8. Poll the guest agent's /health endpoint until it responds 200 OK.
        """
        # Temp directory scoped to this VM. The prefix includes a truncated
        # vm_id for easier identification when debugging leaked temp dirs.
        self._overlay_dir = tempfile.mkdtemp(prefix=f"nightshift-{self.vm_id[:8]}-")
        self._socket_path = os.path.join(self._overlay_dir, "firecracker.sock")

        # Build the overlay rootfs. This mounts the base image read-only and
        # layers a writable overlay on top, then copies the workspace directory and
        # writes env vars into the overlay. The guest sees a complete filesystem.
        self._overlay_path = await create_overlay(
            base_rootfs_path=self.config.base_rootfs_path,
            vm_id=self.vm_id,
            workspace_path=self.config.workspace_path,
            env_vars=self.config.env_vars,
            overlay_dir=self._overlay_dir,
            agent_pkg_path=self.config.agent_pkg_path,
        )

        # Create a TAP device. Returns a TapConfig with host_ip, guest_ip,
        # tap_name, and subnet mask. The TAP device is a virtual L2 network interface
        # that bridges the host and guest network stacks.
        self._tap = await create_tap(self.vm_id)

        # Spawn the firecracker binary. It immediately opens the API socket
        # and waits for configuration. stdout/stderr are captured for debugging.
        self._proc = await asyncio.create_subprocess_exec(
            "firecracker",
            "--api-sock",
            self._socket_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # The socket file is created asynchronously by the firecracker process.
        # Poll up to 5 seconds (50 * 100ms) for it to appear before giving up.
        for _ in range(50):
            if os.path.exists(self._socket_path):
                break
            await asyncio.sleep(0.1)
        else:
            raise RuntimeError("Firecracker socket did not appear")

        # Configure the kernel. Boot args include:
        #   - console=ttyS0  : serial console output (for debugging)
        #   - reboot=k       : use keyboard controller reset on reboot
        #   - panic=1        : reboot 1 second after kernel panic
        #   - pci=off        : disable PCI (Firecracker doesn't emulate it)
        #   - ip=...         : static IP config passed to the kernel so networking
        #                       is available immediately without a DHCP client
        await self._api_put(
            "/boot-source",
            {
                "kernel_image_path": self.config.kernel_path,
                "boot_args": (
                    "console=ttyS0 reboot=k panic=1 pci=off "
                    f"ip={self._tap.guest_ip}::{self._tap.host_ip}:{self._tap.mask}::eth0:off"
                ),
            },
        )

        # Attach the overlay rootfs as the root block device.
        # is_read_only=False because the guest agent writes results back to it.
        await self._api_put(
            "/drives/rootfs",
            {
                "drive_id": "rootfs",
                "path_on_host": self._overlay_path,
                "is_root_device": True,
                "is_read_only": False,
            },
        )

        # Attach the TAP network interface with a deterministic MAC address.
        # The MAC is derived from vm_id so it's reproducible for debugging.
        await self._api_put(
            "/network-interfaces/eth0",
            {
                "iface_id": "eth0",
                "guest_mac": self._generate_mac(),
                "host_dev_name": self._tap.tap_name,
            },
        )

        # Set the machine's hardware resources (vCPUs and memory).
        await self._api_put(
            "/machine-config",
            {
                "vcpu_count": self.config.vcpu_count,
                "mem_size_mib": self.config.mem_size_mib,
            },
        )

        # All config is in place — tell Firecracker to boot the guest kernel.
        # This is a non-blocking call; the VM starts booting in the background.
        await self._api_put("/actions", {"action_type": "InstanceStart"})

        # Block until the guest agent's /health endpoint responds 200.
        # This confirms that the kernel booted, init ran, and the agent process
        # is up and ready to accept work.
        await self._wait_for_health()

    async def wait_for_completion(
        self,
        log: EventLog,
        run_id: str,
    ) -> None:
        """Subscribe to the guest agent's /events SSE stream and forward events to the host log.

        The guest agent emits events as Server-Sent Events. This method
        consumes that stream and re-publishes each event on the host's EventLog,
        tagged with the run_id so consumers can filter by task.

        Returns when a terminal event is received:
            - nightshift.completed : the agent finished successfully
            - nightshift.error     : the agent encountered a fatal error
        """
        url = f"{self.guest_url}/events"

        # Use an infinite timeout — the SSE stream stays open for the entire
        # duration of the agent's work, which could be minutes or hours.
        async with httpx.AsyncClient(timeout=None) as client:
            async with aconnect_sse(client, "GET", url) as sse:
                async for event in sse.aiter_sse():
                    # Skip keepalive/empty events (SSE spec allows empty data fields)
                    if not event.data:
                        continue
                    try:
                        data = json.loads(event.data)
                    except json.JSONDecodeError:
                        # Malformed event — skip rather than crash the stream
                        continue

                    # The event type can come from either the JSON payload's "type"
                    # field or the SSE event name. Prefer the payload since it's
                    # more specific (SSE event names may be generic like "message").
                    event_type = data.get("type", event.event)

                    # Forward the raw event data to the host event log.
                    await log.publish_raw(run_id, event_type, data)

                    # Terminal events — the agent is done, so we can stop listening.
                    if event_type in TERMINAL_EVENTS:
                        return

    async def copy_workspace_out(self, dest_path: str) -> None:
        """Gracefully shut down the VM and extract the modified workspace.

        Sends Ctrl+Alt+Del to the guest (triggers a clean shutdown via init),
        waits up to 10 seconds for the process to exit, then falls back to
        SIGKILL if it doesn't cooperate. After the VM is stopped, the workspace
        directory is copied out of the overlay rootfs image to dest_path.

        This must be called BEFORE destroy(), because destroy() removes the
        overlay image that contains the workspace data.
        """
        # Send a graceful shutdown signal. Firecracker translates SendCtrlAltDel
        # into a keyboard event that the guest kernel handles as a reboot/shutdown.
        try:
            await self._api_put("/actions", {"action_type": "SendCtrlAltDel"})
            if self._proc:
                try:
                    # Give the guest 10 seconds to shut down cleanly.
                    # A clean shutdown ensures all file buffers are flushed.
                    await asyncio.wait_for(self._proc.wait(), timeout=10)
                except asyncio.TimeoutError:
                    # Guest didn't shut down in time — force kill.
                    self._proc.kill()
        except Exception:
            # If the API call itself fails (e.g., socket already gone),
            # just force-kill the process to ensure it's stopped.
            if self._proc:
                self._proc.kill()

        # Mount the overlay image and copy the /workspace directory out to
        # the host. This is how the agent's work products (code changes,
        # result files) get back to the host filesystem.
        await copy_workspace_out(self._overlay_path, self.vm_id, dest_path)

    async def destroy(self) -> None:
        """Tear down all resources associated with this VM.

        Cleans up in reverse order of creation:
            1. Kill the firecracker process (if still running)
            2. Remove the TAP network device
            3. Remove the overlay rootfs image (unmount + delete)
            4. Remove the API socket file
            5. Remove the temporary directory

        Safe to call multiple times — each step is guarded by a None/existence check.
        """
        # Kill the firecracker process if it's still alive.
        # returncode is None while the process is running.
        if self._proc and self._proc.returncode is None:
            self._proc.kill()
            await self._proc.wait()

        # Delete the TAP device from the host network stack.
        if self._tap:
            await destroy_tap(self._tap)

        # Unmount and delete the overlay rootfs image.
        if self._overlay_path:
            await destroy_overlay(self._overlay_path)

        # Clean up the API socket file.
        if self._socket_path and os.path.exists(self._socket_path):
            os.remove(self._socket_path)

        # Remove the entire temp directory (contains overlay + socket).
        # ignore_errors=True because some files may already be cleaned up above.
        if self._overlay_dir and os.path.isdir(self._overlay_dir):
            import shutil

            shutil.rmtree(self._overlay_dir, ignore_errors=True)

    async def _api_put(self, path: str, body: dict) -> dict:
        """Send a PUT request to the Firecracker REST API over the Unix domain socket.

        Firecracker exposes its management API on a Unix socket (not TCP).
        We use httpx's UDS transport to send HTTP requests over it. The base_url
        is "http://localhost" but the actual transport goes through the socket file.

        Raises RuntimeError if the API returns an HTTP 4xx/5xx error.
        """
        transport = httpx.AsyncHTTPTransport(uds=self._socket_path)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as client:
            r = await client.put(path, json=body)
            if r.status_code >= 400:
                raise RuntimeError(f"Firecracker API error on {path}: {r.status_code} {r.text}")
            # Some Firecracker endpoints return empty bodies on success (e.g., /actions)
            return r.json() if r.text else {}

    async def _wait_for_health(self) -> None:
        """Poll the guest agent's /health endpoint until it responds 200 OK.

        This blocks until the guest OS has booted, init has run, and the
        agent HTTP server is accepting connections. Each poll has a 2-second
        HTTP timeout to avoid hanging on unresponsive connections.

        The total wait time is (health_timeout * 2) * 0.5s = health_timeout seconds.
        Default: 60 seconds.

        Raises TimeoutError if the health check never succeeds.
        """
        url = f"{self.guest_url}/health"
        for _ in range(self.config.health_timeout * 2):
            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    r = await client.get(url)
                    if r.status_code == 200:
                        return
            except httpx.HTTPError:
                # Connection refused, timeout, etc. — the guest isn't ready yet.
                pass
            await asyncio.sleep(0.5)
        raise TimeoutError(f"VM {self.vm_id} health check timed out")

    def _generate_mac(self) -> str:
        """Generate a deterministic MAC address from the vm_id.

        Uses a hash of the vm_id to produce 6 octets, then sets the
        locally-administered bit (bit 1 of first octet) and clears the
        multicast bit (bit 0 of first octet). This ensures:
            - The MAC won't collide with real hardware MACs (which are
              globally administered).
            - The MAC is unicast (not broadcast/multicast).
            - The same vm_id always produces the same MAC (reproducible).
        """
        h = hash(self.vm_id) & 0xFFFFFFFFFFFF
        # Extract 6 bytes from the hash, one per octet
        octets = [(h >> (i * 8)) & 0xFF for i in range(6)]
        # Set locally administered bit (0x02), clear multicast bit (0xFE)
        octets[0] = (octets[0] | 0x02) & 0xFE
        return ":".join(f"{o:02x}" for o in octets)


