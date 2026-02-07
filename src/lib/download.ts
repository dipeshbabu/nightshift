import { mkdirSync } from "fs";

export async function download(url: string, dest: string): Promise<void> {
  console.log(`  Downloading ${url}`);
  const proc = Bun.spawn(["curl", "-fSL", "-o", dest, url], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`Failed to download ${url} (curl exit ${exitCode})`);
  console.log(`  Saved to ${dest}`);
}

export async function extract(archive: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });

  if (archive.endsWith(".zip")) {
    const proc = Bun.spawn(["unzip", "-o", archive, "-d", destDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`unzip failed (${exitCode}): ${err}`);
    }
  } else {
    // tar.gz or tar.xz
    const proc = Bun.spawn(["tar", "xf", archive, "-C", destDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tar failed (${exitCode}): ${err}`);
    }
  }
  console.log(`  Extracted to ${destDir}`);
}
