import { join, relative } from "path";
import {
  mkdirSync,
  existsSync,
  chmodSync,
  unlinkSync,
  symlinkSync,
} from "fs";
import type { BinaryMapping } from "./types";
import { detectPlatform } from "../../lib/platform";
import { uvUrl, ripgrepUrl, opencodeUrl } from "../../lib/tools";

async function installToolForEval(
  name: string,
  url: string,
  prefix: string,
  binaryMappings: BinaryMapping[],
): Promise<void> {
  const toolsDir = join(prefix, "tools", name);
  const binDir = join(prefix, "bin");
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const archiveName = url.split("/").pop()!;
  const archivePath = join(prefix, "tools", archiveName);

  // Download
  const downloadProc = Bun.spawn(["curl", "-fSL", "-o", archivePath, url], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await downloadProc.exited) !== 0) {
    throw new Error(`Failed to download ${url}`);
  }

  // Extract (handle both .tar.gz and .zip)
  if (archivePath.endsWith(".zip")) {
    const extractProc = Bun.spawn(
      ["unzip", "-o", archivePath, "-d", toolsDir],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if ((await extractProc.exited) !== 0) {
      throw new Error(`Failed to extract ${archiveName}`);
    }
  } else {
    const extractProc = Bun.spawn(["tar", "xf", archivePath, "-C", toolsDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await extractProc.exited) !== 0) {
      throw new Error(`Failed to extract ${archiveName}`);
    }
  }

  // Create symlinks
  for (const mapping of binaryMappings) {
    const linkPath = join(binDir, mapping.linkName);
    const targetAbsolute = join(toolsDir, mapping.target);

    if (!existsSync(targetAbsolute)) {
      console.warn(`  Warning: binary not found at ${targetAbsolute}`);
      continue;
    }

    chmodSync(targetAbsolute, 0o755);

    const relTarget = relative(binDir, targetAbsolute);
    if (existsSync(linkPath)) {
      unlinkSync(linkPath);
    }
    symlinkSync(relTarget, linkPath);
  }

  // Clean up archive
  unlinkSync(archivePath);
}

export function generateEvalOpencodeConfig(model?: string): string {
  return JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      ...(model && { model }),
      permission: {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        write: "allow",
        codesearch: "allow",
        read: "allow",
        grep: "allow",
        glob: "allow",
        list: "allow",
        lsp: "allow",
        skill: "allow",
        todowrite: "allow",
        todoread: "allow",
        question: "allow",
      },
    },
    null,
    2,
  );
}

export async function installEvalEnvironment(prefix: string): Promise<void> {
  const platform = detectPlatform();

  console.log("Installing uv...");
  const uv = uvUrl(platform);
  await installToolForEval("uv", uv.url, prefix, [
    { linkName: "uv", target: uv.extractedBinary },
  ]);

  console.log("Installing ripgrep...");
  const rg = ripgrepUrl(platform);
  await installToolForEval("ripgrep", rg.url, prefix, [
    { linkName: "rg", target: rg.extractedBinary },
  ]);

  console.log("Installing opencode...");
  const oc = opencodeUrl(platform);
  await installToolForEval("opencode", oc.url, prefix, [
    { linkName: "opencode", target: oc.extractedBinary },
  ]);

  // Create XDG directories
  for (const dir of ["config", "share", "cache", "state"]) {
    mkdirSync(join(prefix, dir), { recursive: true });
  }
}
