import { join, relative } from "path";
import { mkdirSync, existsSync, chmodSync, symlinkSync, unlinkSync } from "fs";
import type { Platform, BinaryMapping } from "./types";
import { OPENCODE_VERSION, UV_VERSION, RIPGREP_VERSION, RUBY_VERSION } from "./constants";
import { download, extract } from "./download";
import { buildUvEnv } from "./env";

export function opencodeUrl(p: Platform): { url: string; extractedBinary: string } {
  const os = p.os === "darwin" ? "darwin" : "linux";
  const arch = p.arch === "aarch64" ? "arm64" : "x64";
  const ext = p.os === "darwin" ? "zip" : "tar.gz";
  return {
    url: `https://github.com/anomalyco/opencode/releases/download/${OPENCODE_VERSION}/opencode-${os}-${arch}.${ext}`,
    extractedBinary: "opencode",
  };
}

export function uvUrl(p: Platform): { url: string; extractedBinary: string } {
  const triple =
    p.os === "darwin"
      ? `${p.arch}-apple-darwin`
      : `${p.arch}-unknown-linux-gnu`;
  return {
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.tar.gz`,
    extractedBinary: `uv-${triple}/uv`,
  };
}

export function ripgrepUrl(p: Platform): { url: string; extractedBinary: string } {
  const triple =
    p.os === "darwin"
      ? `${p.arch}-apple-darwin`
      : p.arch === "x86_64"
        ? `x86_64-unknown-linux-musl`
        : `aarch64-unknown-linux-gnu`;
  return {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-${triple}.tar.gz`,
    extractedBinary: `ripgrep-${RIPGREP_VERSION}-${triple}/rg`,
  };
}

export async function installTool(
  name: string,
  url: string,
  prefix: string,
  binaryMappings: BinaryMapping[],
): Promise<void> {
  console.log(`\nInstalling ${name}...`);
  const toolsDir = join(prefix, "tools", name);
  const binDir = join(prefix, "bin");
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const archiveName = url.split("/").pop()!;
  const archivePath = join(prefix, "tools", archiveName);

  await download(url, archivePath);
  await extract(archivePath, toolsDir);

  // Create symlinks
  for (const mapping of binaryMappings) {
    const linkPath = join(binDir, mapping.linkName);
    const targetAbsolute = join(toolsDir, mapping.target);

    if (!existsSync(targetAbsolute)) {
      console.warn(`  Warning: binary not found at ${targetAbsolute}`);
      continue;
    }

    // Ensure executable
    chmodSync(targetAbsolute, 0o755);

    // Create relative symlink
    const relTarget = relative(binDir, targetAbsolute);
    if (existsSync(linkPath)) {
      const { unlinkSync } = await import("fs");
      unlinkSync(linkPath);
    }
    symlinkSync(relTarget, linkPath);
    console.log(`  Linked ${mapping.linkName} → ${relTarget}`);
  }

  // Clean up archive
  const { unlinkSync } = await import("fs");
  unlinkSync(archivePath);
}

export function portableRubyUrl(p: Platform): { url: string; extractedBinary: string } {
  const base = `https://github.com/Homebrew/homebrew-portable-ruby/releases/download/${RUBY_VERSION}`;
  const asset =
    p.os === "darwin" && p.arch === "aarch64"
      ? `portable-ruby-${RUBY_VERSION}.arm64_big_sur.bottle.tar.gz`
      : p.os === "darwin" && p.arch === "x86_64"
        ? `portable-ruby-${RUBY_VERSION}.el_capitan.bottle.tar.gz`
        : p.os === "linux" && p.arch === "x86_64"
          ? `portable-ruby-${RUBY_VERSION}.x86_64_linux.bottle.tar.gz`
          : `portable-ruby-${RUBY_VERSION}.arm64_linux.bottle.tar.gz`;
  return {
    url: `${base}/${asset}`,
    extractedBinary: `portable-ruby/${RUBY_VERSION}/bin/ruby`,
  };
}

export async function installRubyAndGollum(prefix: string): Promise<void> {
  const platform = (await import("./platform")).detectPlatform();
  const ruby = portableRubyUrl(platform);

  await installTool("ruby", ruby.url, prefix, [
    { linkName: "ruby", target: `portable-ruby/${RUBY_VERSION}/bin/ruby` },
    { linkName: "gem", target: `portable-ruby/${RUBY_VERSION}/bin/gem` },
  ]);

  console.log("\nInstalling gollum gem...");
  const gemBin = join(prefix, "bin", "gem");
  const gemHome = join(prefix, "gems");
  mkdirSync(gemHome, { recursive: true });

  const proc = Bun.spawn([gemBin, "install", "gollum"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      GEM_HOME: gemHome,
      PATH: `${join(prefix, "bin")}:${process.env.PATH}`,
    },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`gem install gollum failed (${exitCode})`);

  // Symlink gollum binary from gems/bin into prefix/bin
  const gollumSrc = join(gemHome, "bin", "gollum");
  const gollumLink = join(prefix, "bin", "gollum");
  if (existsSync(gollumSrc)) {
    if (existsSync(gollumLink)) {
      unlinkSync(gollumLink);
    }
    const relTarget = relative(join(prefix, "bin"), gollumSrc);
    symlinkSync(relTarget, gollumLink);
    console.log(`  Linked gollum → ${relTarget}`);
  } else {
    console.warn(`  Warning: gollum binary not found at ${gollumSrc}`);
  }
  console.log("  gollum installed successfully.");
}

export async function installUvTools(prefix: string): Promise<void> {
  console.log(`\nInstalling uv tools...`);
  const uv = join(prefix, "bin", "uv");
  const toolDir = join(prefix, "uv-tools");
  const toolBinDir = join(prefix, "uv-tools", "bin");

  const proc = Bun.spawn([uv, "tool", "install", "ty"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ...buildUvEnv(prefix),
      PATH: `${join(prefix, "bin")}:${process.env.PATH}`,
      UV_TOOL_DIR: toolDir,
      UV_TOOL_BIN_DIR: toolBinDir,
    },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`uv tool install failed (${exitCode})`);
  console.log("  ty installed successfully.");
}
