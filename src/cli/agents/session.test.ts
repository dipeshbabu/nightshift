import { test, expect } from "bun:test";
import { parseModel, getCommitHash } from "./session";

test("parseModel splits openai model correctly", () => {
  const result = parseModel("openai/gpt-5.2-codex");
  expect(result).toEqual({ providerID: "openai", modelID: "gpt-5.2-codex" });
});

test("parseModel splits anthropic model correctly", () => {
  const result = parseModel("anthropic/claude-sonnet-4-5-20250929");
  expect(result).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5-20250929" });
});

test("parseModel handles model IDs with slashes", () => {
  const result = parseModel("provider/org/model-name");
  expect(result).toEqual({ providerID: "provider", modelID: "org/model-name" });
});

test("getCommitHash returns a 6-char hex string", async () => {
  const hash = await getCommitHash(process.cwd());
  expect(hash).toMatch(/^[0-9a-f]{6}$/);
});
