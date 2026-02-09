import { test, expect } from "bun:test";

// The validator uses `output.includes("VERDICT: DONE")` to detect completion.
// Test this logic directly since it's the core detection mechanism.

function isDone(output: string): boolean {
  return output.includes("VERDICT: DONE");
}

test("output containing VERDICT: DONE returns done: true", () => {
  const output = "I have reviewed the code thoroughly.\nVERDICT: DONE\n";
  expect(isDone(output)).toBe(true);
});

test("output without VERDICT: DONE returns done: false", () => {
  const output = "The task is not complete. Missing error handling in auth module.";
  expect(isDone(output)).toBe(false);
});

test("VERDICT: NOT DONE does not match as done", () => {
  const output = "VERDICT: NOT DONE\nThe tests are failing.";
  expect(isDone(output)).toBe(false);
});

test("output with VERDICT: DONE followed by explanation returns done: true", () => {
  const output = "VERDICT: DONE\nAll tests pass and the feature works correctly.";
  expect(isDone(output)).toBe(true);
});

test("plain DONE without VERDICT prefix does not match", () => {
  const output = "DONE - all checks pass.";
  expect(isDone(output)).toBe(false);
});

test("output with lowercase done does not match", () => {
  const output = "The work is done but not verified.";
  expect(isDone(output)).toBe(false);
});
