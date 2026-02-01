import { test, expect } from "bun:test";
import { buildSandboxCommand, type SandboxOptions } from "../src/sandbox";

const mockOptions: SandboxOptions = {
  workspacePath: "/home/user/workspace",
  prefixPath: "/home/user/.nightshift",
  binDir: "/home/user/.nightshift/bin",
  env: {
    HOME: "/home/user",
    PATH: "/home/user/.nightshift/bin:/usr/bin",
    TERM: "xterm-256color",
  },
};

test("buildSandboxCommand returns bwrap command on Linux", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", writable: true });

  try {
    const command = buildSandboxCommand(["opencode", "--help"], mockOptions);
    expect(command[0]).toBe("/home/user/.nightshift/bin/bwrap");
    expect(command).toContain("--ro-bind");
    expect(command).toContain("--bind");
    expect(command).toContain("--tmpfs");
    expect(command).toContain("--");
    expect(command).toContain("opencode");
    expect(command).toContain("--help");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  }
});

test("buildSandboxCommand includes workspace and prefix as writable binds on Linux", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", writable: true });

  try {
    const command = buildSandboxCommand(["opencode"], mockOptions);

    // Find the --bind pairs for workspace and prefix
    const bindIndexes: number[] = [];
    command.forEach((arg, i) => {
      if (arg === "--bind") bindIndexes.push(i);
    });

    // Should have at least 2 --bind (workspace and prefix)
    expect(bindIndexes.length).toBeGreaterThanOrEqual(2);

    // Check workspace bind
    const workspaceBindIndex = command.indexOf(mockOptions.workspacePath);
    expect(workspaceBindIndex).toBeGreaterThan(0);

    // Check prefix bind
    const prefixBindIndex = command.indexOf(mockOptions.prefixPath);
    expect(prefixBindIndex).toBeGreaterThan(0);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  }
});

test("buildSandboxCommand includes environment variables on Linux", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", writable: true });

  try {
    const command = buildSandboxCommand(["opencode"], mockOptions);

    // Check for --setenv flags
    const setenvIndexes: number[] = [];
    command.forEach((arg, i) => {
      if (arg === "--setenv") setenvIndexes.push(i);
    });

    expect(setenvIndexes.length).toBe(Object.keys(mockOptions.env).length);

    // Check specific env vars
    const homeSetenvIndex = command.indexOf("HOME");
    expect(homeSetenvIndex).toBeGreaterThan(0);
    expect(command[homeSetenvIndex + 1]).toBe("/home/user");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  }
});

test("buildSandboxCommand returns sandbox-exec command on Darwin", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "darwin", writable: true });

  try {
    const command = buildSandboxCommand(["opencode", "--help"], mockOptions);
    expect(command[0]).toBe("sandbox-exec");
    expect(command[1]).toBe("-f");
    expect(command[2]).toContain("sandbox.sb");
    expect(command).toContain("opencode");
    expect(command).toContain("--help");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  }
});

test("buildSandboxCommand returns original command on unsupported platforms", () => {
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", writable: true });

  try {
    const command = buildSandboxCommand(["opencode", "--help"], mockOptions);
    expect(command).toEqual(["opencode", "--help"]);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  }
});
