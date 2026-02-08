import { test, expect } from "bun:test";

// The validator uses `output.includes("DONE")` to detect completion.
// Test this logic directly since it's the core detection mechanism.

function isDone(output: string): boolean {
  return output.includes("DONE");
}

test("output containing DONE on its own line returns done: true", () => {
  const output = "I have reviewed the code thoroughly.\nDONE\n";
  expect(isDone(output)).toBe(true);
});

test("output without DONE returns done: false", () => {
  const output = "The task is not complete. Missing error handling in auth module.";
  expect(isDone(output)).toBe(false);
});

test("output with DONE embedded in other text returns done: true", () => {
  const output = "All checks pass. DONE.";
  expect(isDone(output)).toBe(true);
});

test("output with DONE followed by explanation returns done: true", () => {
  const output = "DONE - all tests pass and the feature works correctly.";
  expect(isDone(output)).toBe(true);
});

test("output with lowercase done does not match", () => {
  const output = "The work is done but not verified.";
  expect(isDone(output)).toBe(false);
});
