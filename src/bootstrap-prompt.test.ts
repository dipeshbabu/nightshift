import { test, expect, describe, afterEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { runBootstrapPrompt, type BootstrapUI } from "./bootstrap-prompt";

describe("bootstrap prompt UI", () => {
  let testEnv: Awaited<ReturnType<typeof createTestRenderer>> | null = null;

  afterEach(() => {
    if (testEnv) {
      testEnv.renderer.destroy();
      testEnv = null;
    }
  });

  test("renders prompt text", async () => {
    testEnv = await createTestRenderer({ width: 80, height: 24 });
    const { renderer, renderOnce, captureCharFrame, mockInput } = testEnv;

    // Start the prompt but don't await it (it waits for user input)
    const promptPromise = runBootstrapPrompt(
      async () => { },
      { renderer, skipTtyCheck: true, autoStart: false }
    );

    await renderOnce();
    const frame = captureCharFrame();

    // Check that the prompt text is rendered
    expect(frame).toContain("What are you going to use nightshift for?");
    expect(frame).toContain("Press Enter to submit");

    // Clean up by simulating Ctrl+C (with key event format the renderer expects)
    mockInput.pressKey("c", { ctrl: true });
    await renderOnce();

    // Give time for the cleanup to happen
    const result = await Promise.race([
      promptPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))
    ]);
    expect(result).toBeNull();
  });

  test("returns user input on Enter", async () => {
    testEnv = await createTestRenderer({ width: 80, height: 24 });
    const { renderer, renderOnce, mockInput } = testEnv;

    let capturedIntent = "";
    const promptPromise = runBootstrapPrompt(
      async (intent) => {
        capturedIntent = intent;
      },
      { renderer, skipTtyCheck: true, autoStart: false }
    );

    await renderOnce();

    // Type some text
    await mockInput.typeText("managing my finances");
    await renderOnce();

    // Press Enter
    mockInput.pressEnter();
    await renderOnce();

    const result = await promptPromise;

    expect(result).toBe("managing my finances");
    expect(capturedIntent).toBe("managing my finances");
  });
});

describe("bootstrap prompt UI - showBashOutput", () => {
  let testEnv: Awaited<ReturnType<typeof createTestRenderer>> | null = null;

  afterEach(() => {
    if (testEnv) {
      testEnv.renderer.destroy();
      testEnv = null;
    }
  });

  test("truncates long output and shows expand hint", async () => {
    testEnv = await createTestRenderer({ width: 80, height: 40 });
    const { renderer, renderOnce, mockInput, captureCharFrame } = testEnv;

    let ui: BootstrapUI | null = null;
    const promptPromise = runBootstrapPrompt(
      async (intent, bootstrapUI) => {
        ui = bootstrapUI;
        // Generate 20 lines of output
        const longOutput = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
        ui.showBashOutput("echo test", longOutput);
      },
      { renderer, skipTtyCheck: true, autoStart: false }
    );

    await renderOnce();

    // Type and submit to trigger the callback
    await mockInput.typeText("test intent");
    mockInput.pressEnter();
    await renderOnce();

    // Wait a bit for the callback to run
    await new Promise((r) => setTimeout(r, 50));
    await renderOnce();

    const frame = captureCharFrame();

    // Should show first 10 lines
    expect(frame).toContain("line 1");
    expect(frame).toContain("line 10");
    // Should show truncation message with click hint
    expect(frame).toContain("10 more lines");
    expect(frame).toContain("click to expand");
    // Should NOT show line 11+ initially
    expect(frame).not.toContain("line 11");

    // Cleanup
    await promptPromise;
  });

  test("expands and collapses on click", async () => {
    testEnv = await createTestRenderer({ width: 80, height: 60 });
    const { renderer, renderOnce, mockInput, mockMouse, captureCharFrame } = testEnv;

    let ui: BootstrapUI | null = null;
    const promptPromise = runBootstrapPrompt(
      async (intent, bootstrapUI) => {
        ui = bootstrapUI;
        const longOutput = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
        ui.showBashOutput("echo test", longOutput);
      },
      { renderer, skipTtyCheck: true, autoStart: false }
    );

    await renderOnce();

    // Submit to trigger callback
    await mockInput.typeText("test");
    mockInput.pressEnter();
    await renderOnce();
    await new Promise((r) => setTimeout(r, 50));
    await renderOnce();

    // Find the "click to expand" text and click on it
    let frame = captureCharFrame();
    const lines = frame.split("\n");
    let expandLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("click to expand")) {
        expandLineIndex = i;
        break;
      }
    }

    expect(expandLineIndex).toBeGreaterThan(-1);

    // Click on the expand text
    await mockMouse.click(10, expandLineIndex);
    await renderOnce();

    frame = captureCharFrame();

    // Should now show all lines
    expect(frame).toContain("line 15");
    expect(frame).toContain("line 20");
    expect(frame).toContain("click to collapse");

    // Click again to collapse
    const linesAfterExpand = frame.split("\n");
    let collapseLineIndex = -1;
    for (let i = 0; i < linesAfterExpand.length; i++) {
      if (linesAfterExpand[i].includes("click to collapse")) {
        collapseLineIndex = i;
        break;
      }
    }

    expect(collapseLineIndex).toBeGreaterThan(-1);

    await mockMouse.click(10, collapseLineIndex);
    await renderOnce();

    frame = captureCharFrame();

    // Should be collapsed again
    expect(frame).toContain("click to expand");
    expect(frame).not.toContain("line 15");

    await promptPromise;
  });
});

describe("bootstrap prompt UI - showWriteOutput", () => {
  let testEnv: Awaited<ReturnType<typeof createTestRenderer>> | null = null;

  afterEach(() => {
    if (testEnv) {
      testEnv.renderer.destroy();
      testEnv = null;
    }
  });

  test("truncates long content and shows expand hint", async () => {
    testEnv = await createTestRenderer({ width: 80, height: 40 });
    const { renderer, renderOnce, mockInput, captureCharFrame } = testEnv;

    const promptPromise = runBootstrapPrompt(
      async (intent, ui) => {
        const longContent = Array.from({ length: 25 }, (_, i) => `content line ${i + 1}`).join("\n");
        ui.showWriteOutput("/path/to/file.txt", longContent);
      },
      { renderer, skipTtyCheck: true, autoStart: false }
    );

    await renderOnce();

    await mockInput.typeText("test");
    mockInput.pressEnter();
    await renderOnce();
    await new Promise((r) => setTimeout(r, 50));
    await renderOnce();

    const frame = captureCharFrame();

    // Should show first 10 lines
    expect(frame).toContain("content line 1");
    expect(frame).toContain("content line 10");
    // Should show truncation message
    expect(frame).toContain("15 more lines");
    expect(frame).toContain("click to expand");
    // Should show file path
    expect(frame).toContain("/path/to/file.txt");

    await promptPromise;
  });

  test("expands and collapses write output on click", async () => {
    testEnv = await createTestRenderer({ width: 80, height: 60 });
    const { renderer, renderOnce, mockInput, mockMouse, captureCharFrame } = testEnv;

    const promptPromise = runBootstrapPrompt(
      async (intent, ui) => {
        const longContent = Array.from({ length: 20 }, (_, i) => `write line ${i + 1}`).join("\n");
        ui.showWriteOutput("/test/file.py", longContent);
      },
      { renderer, skipTtyCheck: true, autoStart: false }
    );

    await renderOnce();

    await mockInput.typeText("test");
    mockInput.pressEnter();
    await renderOnce();
    await new Promise((r) => setTimeout(r, 50));
    await renderOnce();

    // Find and click expand
    let frame = captureCharFrame();
    const lines = frame.split("\n");
    let expandLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("click to expand")) {
        expandLineIndex = i;
        break;
      }
    }

    expect(expandLineIndex).toBeGreaterThan(-1);

    await mockMouse.click(10, expandLineIndex);
    await renderOnce();

    frame = captureCharFrame();

    // Should show all content
    expect(frame).toContain("write line 15");
    expect(frame).toContain("write line 20");
    expect(frame).toContain("click to collapse");

    await promptPromise;
  });
});

describe("bootstrap prompt UI - short output", () => {
  let testEnv: Awaited<ReturnType<typeof createTestRenderer>> | null = null;

  afterEach(() => {
    if (testEnv) {
      testEnv.renderer.destroy();
      testEnv = null;
    }
  });

  test("does not show expand hint for short bash output", async () => {
    testEnv = await createTestRenderer({ width: 80, height: 40 });
    const { renderer, renderOnce, mockInput, captureCharFrame } = testEnv;

    const promptPromise = runBootstrapPrompt(
      async (intent, ui) => {
        ui.showBashOutput("ls", "file1.txt\nfile2.txt\nfile3.txt");
      },
      { renderer, skipTtyCheck: true, autoStart: false }
    );

    await renderOnce();

    await mockInput.typeText("test");
    mockInput.pressEnter();
    await renderOnce();
    await new Promise((r) => setTimeout(r, 50));
    await renderOnce();

    const frame = captureCharFrame();

    // Should show all content
    expect(frame).toContain("file1.txt");
    expect(frame).toContain("file2.txt");
    expect(frame).toContain("file3.txt");
    // Should NOT show expand hint
    expect(frame).not.toContain("click to expand");
    expect(frame).not.toContain("more lines");

    await promptPromise;
  });

  test("does not show expand hint for short write output", async () => {
    testEnv = await createTestRenderer({ width: 80, height: 40 });
    const { renderer, renderOnce, mockInput, captureCharFrame } = testEnv;

    const promptPromise = runBootstrapPrompt(
      async (intent, ui) => {
        ui.showWriteOutput("/test.txt", "line 1\nline 2\nline 3");
      },
      { renderer, skipTtyCheck: true, autoStart: false }
    );

    await renderOnce();

    await mockInput.typeText("test");
    mockInput.pressEnter();
    await renderOnce();
    await new Promise((r) => setTimeout(r, 50));
    await renderOnce();

    const frame = captureCharFrame();

    expect(frame).toContain("line 1");
    expect(frame).toContain("line 2");
    expect(frame).toContain("line 3");
    expect(frame).not.toContain("click to expand");

    await promptPromise;
  });
});
