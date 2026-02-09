import { join, dirname } from "path";
import { homedir } from "os";
import { mkdirSync, existsSync, chmodSync } from "fs";
import type { GitHubRelease } from "./types";
import { detectPlatform } from "./platform";
import { getNightshiftVersion, getNightshiftLibc } from "./constants";
import { download, extract } from "./download";

export async function fetchLatestRelease(): Promise<GitHubRelease> {
  const response = await fetch(
    "https://api.github.com/repos/nightshiftco/nightshift/releases/latest",
    { headers: { Accept: "application/vnd.github+json", "User-Agent": "nightshift-cli" } }
  );
  if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
  return response.json();
}

export function parseVersion(v: string): [number, number, number] {
  const parts = v.replace(/^v/, "").split(".").map(Number);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function isNewerVersion(current: string, latest: string): boolean {
  const [cMaj, cMin, cPat] = parseVersion(current);
  const [lMaj, lMin, lPat] = parseVersion(latest);
  return lMaj > cMaj || (lMaj === cMaj && lMin > cMin) || (lMaj === cMaj && lMin === cMin && lPat > cPat);
}

export function getAssetNameForPlatform(): string {
  const platform = detectPlatform();
  // Map our Platform to the build naming convention
  const os = platform.os; // "darwin" | "linux"
  const arch = platform.arch === "aarch64" ? "arm64" : "x64";

  // Check if we're on musl libc (Linux only)
  const libc = getNightshiftLibc();
  const isMusl = libc === "musl";

  // Build asset name: nightshift-{os}-{arch}[-musl].tar.gz
  const parts = ["nightshift", os, arch];
  if (isMusl) parts.push("musl");

  return `${parts.join("-")}.tar.gz`;
}

export async function upgrade(options: { force?: boolean }): Promise<void> {
  // Get current version
  const currentVersion = getNightshiftVersion();
  console.log(`Current version: ${currentVersion}`);

  // Fetch latest release
  console.log("Checking for updates...");
  const release = await fetchLatestRelease();
  const latestVersion = release.tag_name;
  console.log(`Latest version: ${latestVersion}`);

  // Compare versions
  if (!options.force && !isNewerVersion(currentVersion, latestVersion)) {
    console.log("You are already running the latest version.");
    return;
  }

  if (options.force) {
    console.log("Force flag set, proceeding with upgrade...");
  }

  // Find asset for current platform
  const assetName = getAssetNameForPlatform();
  const asset = release.assets.find(a => a.name === assetName);

  if (!asset) {
    throw new Error(`No release asset found for ${assetName}. Available assets: ${release.assets.map(a => a.name).join(", ")}`);
  }

  console.log(`\nDownloading ${assetName}...`);

  // Set up directories
  const home = process.env.HOME || homedir();
  const cacheDir = join(home, ".cache", "nightshift-upgrade");
  const archivePath = join(cacheDir, assetName);
  const extractDir = join(cacheDir, "extract");

  // Update the currently running binary
  const binaryDest = join(home, ".nightshift", "bin", "nightshift")
  console.log(`  Target: ${binaryDest}`);

  mkdirSync(cacheDir, { recursive: true });

  // Clean up previous extract dir if it exists
  if (existsSync(extractDir)) {
    const { rmSync } = await import("fs");
    rmSync(extractDir, { recursive: true });
  }

  // Download archive
  await download(asset.browser_download_url, archivePath);

  // Extract archive
  await extract(archivePath, extractDir);

  // The binary is extracted as just "nightshift" in the extract dir
  const extractedBinary = join(extractDir, "nightshift");

  if (!existsSync(extractedBinary)) {
    throw new Error(`Binary not found after extraction at ${extractedBinary}`);
  }

  // Backup existing binary if it exists
  const backupPath = `${binaryDest}.backup`;
  if (existsSync(binaryDest)) {
    const { copyFileSync } = await import("fs");
    copyFileSync(binaryDest, backupPath);
    console.log(`  Backed up existing binary to ${backupPath}`);
  }

  try {
    // Ensure destination directory exists and install new binary
    const { copyFileSync } = await import("fs");
    mkdirSync(dirname(binaryDest), { recursive: true });
    copyFileSync(extractedBinary, binaryDest);
    chmodSync(binaryDest, 0o755);
    console.log(`  Installed to ${binaryDest}`);

    // Clean up backup on success
    if (existsSync(backupPath)) {
      const { unlinkSync } = await import("fs");
      unlinkSync(backupPath);
    }
  } catch (err) {
    // Restore backup on failure
    if (existsSync(backupPath)) {
      const { copyFileSync } = await import("fs");
      copyFileSync(backupPath, binaryDest);
      console.log("  Restored backup after failed upgrade");
    }
    throw err;
  }

  // Clean up
  const { unlinkSync, rmSync } = await import("fs");
  unlinkSync(archivePath);
  rmSync(extractDir, { recursive: true });

  console.log(`\nSuccessfully upgraded to ${latestVersion}`);
}
