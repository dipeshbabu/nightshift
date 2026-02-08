import { test, expect, mock } from "bun:test";
import { runAgentLoop } from "./loop";

// Mock the executor and validator modules
const mockExecute = mock(() => Promise.resolve({
  output: "Agent completed the task.",
  commitHash: "abc123",
}));

const mockValidate = mock(() => Promise.resolve({
  output: "DONE",
  done: true,
}));

// Override module imports
mock.module("./executor", () => ({
  execute: mockExecute,
}));

mock.module("./validator", () => ({
  validate: mockValidate,
}));

const fakeClient = {} as any;

test("loop exits on first iteration when validator returns done: true", async () => {
  mockExecute.mockResolvedValueOnce({
    output: "Task completed successfully.",
    commitHash: "abc123",
  });
  mockValidate.mockResolvedValueOnce({
    output: "DONE",
    done: true,
  });

  const result = await runAgentLoop({
    client: fakeClient,
    workspace: "/tmp/test",
    prompt: "Fix the bug",
    agentModel: "openai/gpt-5.2-codex",
    evalModel: "openai/gpt-5.2-codex",
  });

  expect(result.done).toBe(true);
  expect(result.iterations).toBe(1);
  expect(result.finalOutput).toBe("Task completed successfully.");
});

test("loop carries forward outputs when validator returns done: false", async () => {
  mockExecute
    .mockResolvedValueOnce({
      output: "First attempt output.",
      commitHash: "aaa111",
    })
    .mockResolvedValueOnce({
      output: "Second attempt output.",
      commitHash: "bbb222",
    });

  mockValidate
    .mockResolvedValueOnce({
      output: "Not done yet. Missing tests.",
      done: false,
    })
    .mockResolvedValueOnce({
      output: "DONE",
      done: true,
    });

  const result = await runAgentLoop({
    client: fakeClient,
    workspace: "/tmp/test",
    prompt: "Add tests",
    agentModel: "openai/gpt-5.2-codex",
    evalModel: "openai/gpt-5.2-codex",
  });

  expect(result.done).toBe(true);
  expect(result.iterations).toBe(2);
  expect(result.finalOutput).toBe("Second attempt output.");
});

test("loop respects maxIterations", async () => {
  mockExecute.mockResolvedValue({
    output: "Still working...",
    commitHash: "ccc333",
  });
  mockValidate.mockResolvedValue({
    output: "Not done.",
    done: false,
  });

  const result = await runAgentLoop({
    client: fakeClient,
    workspace: "/tmp/test",
    prompt: "Impossible task",
    agentModel: "openai/gpt-5.2-codex",
    evalModel: "openai/gpt-5.2-codex",
    maxIterations: 3,
  });

  expect(result.done).toBe(false);
  expect(result.iterations).toBe(3);
});
