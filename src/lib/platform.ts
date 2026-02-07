import type { Platform } from "./types";

export function detectPlatform(): Platform {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return { os, arch };
}

export function getCpuName(): string {
  const cpus = require("os").cpus();
  if (cpus.length === 0) return "Unknown CPU";
  return cpus[0].model.replace(/\s+/g, " ").trim();
}

export function getGpuName(): string | null {
  try {
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(["system_profiler", "SPDisplaysDataType", "-json"]);
      if (result.exitCode === 0) {
        const data = JSON.parse(result.stdout.toString());
        const displays = data?.SPDisplaysDataType;
        if (displays?.[0]?.sppci_model) {
          return displays[0].sppci_model;
        }
      }
    } else if (process.platform === "linux") {
      // Try nvidia-smi first
      const nvidia = Bun.spawnSync(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"]);
      if (nvidia.exitCode === 0) {
        const name = nvidia.stdout.toString().trim().split("\n")[0];
        if (name) return name;
      }
      // Fallback to lspci for other GPUs
      const lspci = Bun.spawnSync(["lspci"]);
      if (lspci.exitCode === 0) {
        const lines = lspci.stdout.toString().split("\n");
        const vga = lines.find(l => l.includes("VGA") || l.includes("3D"));
        if (vga) {
          const match = vga.match(/: (.+)$/);
          if (match) return match[1].trim();
        }
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

export async function checkSandboxAvailability(): Promise<{ available: boolean; reason?: string }> {
  if (process.platform === "darwin") {
    // macOS has sandbox-exec built-in
    return { available: true };
  }

  if (process.platform === "linux") {
    // Check if bwrap is available in PATH
    const proc = Bun.spawn(["which", "bwrap"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return { available: true };
    }
    return {
      available: false,
      reason: "bwrap (bubblewrap) not found in PATH. Install it with: apt install bubblewrap (Debian/Ubuntu) or dnf install bubblewrap (Fedora)",
    };
  }

  return {
    available: false,
    reason: "Sandbox is not supported on this platform",
  };
}
