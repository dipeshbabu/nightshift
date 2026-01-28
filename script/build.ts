#!/usr/bin/env bun

import solidPlugin from "../node_modules/@opentui/solid/scripts/solid-plugin"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

import pkg from "../package.json"

const singleFlag = process.argv.includes("--single")

const allTargets: {
  os: string
  arch: "arm64" | "x64"
}[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
]

const targets = singleFlag
  ? allTargets.filter((item) => item.os === process.platform && item.arch === process.arch)
  : allTargets

await Bun.$`rm -rf dist`

for (const item of targets) {
  const name = [pkg.name, item.os, item.arch].join("-")
  console.log(`building ${name}`)
  await Bun.$`mkdir -p dist/${name}/bin`

  const parserWorker = fs.realpathSync(path.resolve(dir, "./node_modules/@opentui/core/parser.worker.js"))

  // Use platform-specific bunfs root path based on target OS
  const bunfsRoot = "/$bunfs/root/"
  const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

  await Bun.build({
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [solidPlugin],
    sourcemap: "external",
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      //@ts-ignore
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: name.replace(pkg.name, "bun") as any,
      outfile: `dist/${name}/bin/nightshift`,
    },
    entrypoints: ["./src/index.ts", parserWorker],
    define: {
      NIGHTSHIFT_VERSION: `'${pkg.version}'`,
      OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    },
  })

  await Bun.file(`dist/${name}/package.json`).write(
    JSON.stringify(
      {
        name,
        version: pkg.version,
        os: [item.os],
        cpu: [item.arch],
      },
      null,
      2,
    ),
  )
}

console.log("Build complete!")
