import {
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  DiffRenderable,
  SyntaxStyle,
  RGBA,
} from "@opentui/core";
import { SpinnerRenderable } from "opentui-spinner";
import { createFrames, createColors } from "./cli/cmd/tui/tui/ui/spinner";
import stripAnsi from "strip-ansi";

// Colors for the bootstrap UI
const COLORS = {
  primary: "#fab283",
  text: "#eeeeee",
  textMuted: "#808080",
  background: "#303030",
  backgroundPanel: "#262626",
  toolRunning: "#61afef",
  toolCompleted: "#98c379",
  toolError: "#e06c75",
};

// Syntax style for code highlighting in diffs
const syntaxStyle = SyntaxStyle.fromStyles({
  keyword: { fg: RGBA.fromHex("#FF7B72"), bold: true },
  string: { fg: RGBA.fromHex("#A5D6FF") },
  comment: { fg: RGBA.fromHex("#8B949E"), italic: true },
  number: { fg: RGBA.fromHex("#79C0FF") },
  function: { fg: RGBA.fromHex("#D2A8FF") },
  default: { fg: RGBA.fromHex("#E6EDF3") },
});

export interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

export interface BootstrapUI {
  appendText: (text: string) => void;
  appendToolStatus: (status: "running" | "completed" | "error", text: string) => void;
  setStatus: (status: string) => void;
  showDiff: (diffs: FileDiff[]) => void;
  showBashOutput: (command: string, output: string, description?: string) => void;
  showWriteOutput: (filePath: string, content: string) => void;
  showEditOutput: (filePath: string, diff: string) => void;
  setSpinnerActive: (active: boolean) => void;
}

/**
 * Convert FileDiff to unified diff format
 */
function toUnifiedDiff(diff: FileDiff): string {
  const beforeLines = diff.before.split("\n");
  const afterLines = diff.after.split("\n");

  let result = `--- a/${diff.file}\n+++ b/${diff.file}\n`;

  // Simple unified diff - show all as changed
  if (beforeLines.length > 0 || afterLines.length > 0) {
    result += `@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`;
    for (const line of beforeLines) {
      if (line || beforeLines.length === 1) {
        result += `-${line}\n`;
      }
    }
    for (const line of afterLines) {
      if (line || afterLines.length === 1) {
        result += `+${line}\n`;
      }
    }
  }

  return result;
}

/**
 * Get file extension for syntax highlighting
 */
function getFiletype(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mapping: Record<string, string> = {
    py: "python",
    js: "javascript",
    ts: "typescript",
    tsx: "tsx",
    jsx: "jsx",
    md: "markdown",
    json: "json",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
  };
  return ext ? mapping[ext] : undefined;
}

/**
 * Shows a TUI prompt asking the user what they want to use Nightshift for.
 * When the user submits, transitions to an output view and runs the bootstrap callback.
 *
 * @param onBootstrap - Called with the user's intent and a UI interface for streaming output
 * @returns The user's intent string, or null if they skipped (Ctrl+C)
 */
export async function runBootstrapPrompt(
  onBootstrap: (intent: string, ui: BootstrapUI) => Promise<void>
): Promise<string | null> {
  // Check if we're in a TTY
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Not running in a TTY, skipping bootstrap prompt.");
    return null;
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  return new Promise<string | null>((resolve, reject) => {
    let resolved = false;
    let outputCounter = 0;
    let statusText: TextRenderable;
    let scrollBox: ScrollBoxRenderable;
    let inputContainer: BoxRenderable;
    let outputContainer: BoxRenderable;
    let spinner: SpinnerRenderable;
    let statusContainer: BoxRenderable;
    let contentBox: BoxRenderable;

    const cleanup = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      renderer.destroy();
      resolve(value);
    };

    const cleanupWithError = (err: unknown) => {
      if (resolved) return;
      resolved = true;
      renderer.destroy();
      reject(err);
    };

    // Create spinner frames and colors for knight rider effect
    const spinnerDef = {
      frames: createFrames({
        color: COLORS.primary,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
      colors: createColors({
        color: COLORS.primary,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
    };

    // Create main container
    const container = new BoxRenderable(renderer, {
      id: "container",
      flexDirection: "column",
      width: "100%",
      height: "100%",
    });

    // Create prompt section
    inputContainer = new BoxRenderable(renderer, {
      id: "input-container",
      flexDirection: "column",
      gap: 1,
      padding: 1,
    });

    // Create prompt label
    const label = new TextRenderable(renderer, {
      id: "label",
      content: ":> What are you going to use nightshift for?",
      fg: COLORS.primary,
    });

    // Create input field
    const input = new InputRenderable(renderer, {
      id: "input",
      height: 1,
      width: 60,
      placeholder: "e.g., managing my personal finances, analyzing data...",
      textColor: COLORS.text,
      focusedTextColor: "#ffffff",
      cursorColor: COLORS.primary,
      placeholderColor: COLORS.textMuted,
    });

    // Create help text
    const helpText = new TextRenderable(renderer, {
      id: "help",
      content: "Press Enter to submit, Ctrl+C to skip",
      fg: COLORS.textMuted,
    });

    // Add elements to input container
    inputContainer.add(label);
    inputContainer.add(input);
    inputContainer.add(helpText);

    // Create output section (initially hidden)
    outputContainer = new BoxRenderable(renderer, {
      id: "output-container",
      flexDirection: "column",
      flexGrow: 1,
      padding: 1,
      visible: false,
    });

    // Status container with spinner
    statusContainer = new BoxRenderable(renderer, {
      id: "status-container",
      flexDirection: "row",
      gap: 1,
      height: 1,
    });

    // Knight rider spinner
    spinner = new SpinnerRenderable(renderer, {
      frames: spinnerDef.frames,
      color: spinnerDef.colors,
      interval: 40,
    });

    // Status text
    statusText = new TextRenderable(renderer, {
      id: "status",
      content: "Bootstrapping...",
      fg: COLORS.primary,
    });

    statusContainer.add(spinner);
    statusContainer.add(statusText);

    // Content box for scrollable output and diffs
    contentBox = new BoxRenderable(renderer, {
      id: "content-box",
      flexDirection: "column",
      flexGrow: 1,
    });

    // Scrollable output area with sticky scroll to follow new content
    scrollBox = new ScrollBoxRenderable(renderer, {
      id: "scroll",
      flexGrow: 1,
      width: "100%",
      stickyScroll: true,
      stickyStart: "bottom",
    });

    contentBox.add(scrollBox);

    outputContainer.add(statusContainer);
    outputContainer.add(contentBox);

    // Add sections to main container
    container.add(inputContainer);
    container.add(outputContainer);

    // Add container to root
    renderer.root.add(container);

    // Focus the input
    input.focus();

    // Track current text node for appending deltas to the same line
    let currentTextNode: TextRenderable | null = null;
    let currentTextContent = "";

    // Create UI interface for bootstrap process
    const ui: BootstrapUI = {
      appendText: (text: string) => {
        if (!text) return;

        // Append to existing text node if we have one
        if (currentTextNode) {
          currentTextContent += text;
          currentTextNode.content = currentTextContent;
        } else {
          // Create a new text node for the first delta
          currentTextContent = text;
          currentTextNode = new TextRenderable(renderer, {
            id: `output-${outputCounter++}`,
            content: currentTextContent,
            fg: COLORS.text,
            wrapMode: "word",
          });
          scrollBox.add(currentTextNode);
        }
      },
      appendToolStatus: (status: "running" | "completed" | "error", text: string) => {
        // Reset text node so next text starts fresh after this tool output
        currentTextNode = null;
        currentTextContent = "";

        let prefix: string;
        let color: string;
        switch (status) {
          case "running":
            prefix = "▶";
            color = COLORS.toolRunning;
            break;
          case "completed":
            prefix = "✓";
            color = COLORS.toolCompleted;
            break;
          case "error":
            prefix = "✗";
            color = COLORS.toolError;
            break;
        }
        const statusNode = new TextRenderable(renderer, {
          id: `status-${outputCounter++}`,
          content: `${prefix} ${text}`,
          fg: color,
        });
        scrollBox.add(statusNode);
      },
      setStatus: (status: string) => {
        statusText.content = status;
      },
      showDiff: (diffs: FileDiff[]) => {
        // Reset text node so next text starts fresh after this tool output
        currentTextNode = null;
        currentTextContent = "";

        for (const diff of diffs) {
          // Add file header inline
          const headerNode = new TextRenderable(renderer, {
            id: `diff-header-${outputCounter++}`,
            content: `\n📄 ${diff.file} (+${diff.additions} -${diff.deletions})`,
            fg: COLORS.text,
          });
          scrollBox.add(headerNode);

          // Create unified diff string
          const unifiedDiff = toUnifiedDiff(diff);
          const filetype = getFiletype(diff.file);

          // Create a DiffRenderable for this diff
          const diffRenderable = new DiffRenderable(renderer, {
            id: `diff-${outputCounter++}`,
            diff: unifiedDiff,
            view: "unified",
            syntaxStyle,
            filetype,
            showLineNumbers: true,
            addedBg: RGBA.fromHex("#1a3d1a"),
            removedBg: RGBA.fromHex("#3d1a1a"),
            addedSignColor: RGBA.fromHex("#98c379"),
            removedSignColor: RGBA.fromHex("#e06c75"),
            fg: RGBA.fromHex("#e6edf3"),
            width: "100%",
            height: Math.min(diff.additions + diff.deletions + 4, 20),
          });

          scrollBox.add(diffRenderable);
        }
      },
      showBashOutput: (command: string, output: string, description?: string) => {
        // Reset text node so next text starts fresh after this tool output
        currentTextNode = null;
        currentTextContent = "";

        // Create a BlockTool-style container with left border
        const blockId = `bash-${outputCounter++}`;
        const cleanOutput = stripAnsi(output.trim());

        // Limit output to 10 lines
        const lines = cleanOutput.split("\n");
        const displayLines = lines.slice(0, 10);
        const truncated = lines.length > 10;
        const displayOutput = truncated
          ? displayLines.join("\n") + `\n... (${lines.length - 10} more lines)`
          : cleanOutput;

        // Create container box with left border (BlockTool pattern)
        const blockBox = new BoxRenderable(renderer, {
          id: blockId,
          flexDirection: "column",
          border: ["left"],
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 2,
          marginTop: 1,
          gap: 1,
          backgroundColor: COLORS.backgroundPanel,
          borderColor: COLORS.background,
        });

        // Title text (muted) - use description if provided
        const title = description ? `# ${description}` : "# Shell";
        const titleText = new TextRenderable(renderer, {
          id: `${blockId}-title`,
          content: title,
          fg: COLORS.textMuted,
        });

        // Command with $ prefix
        const commandText = new TextRenderable(renderer, {
          id: `${blockId}-cmd`,
          content: `$ ${command}`,
          fg: COLORS.text,
        });

        // Output text
        const outputTextNode = new TextRenderable(renderer, {
          id: `${blockId}-output`,
          content: displayOutput,
          fg: COLORS.text,
          wrapMode: "word",
        });

        blockBox.add(titleText);
        blockBox.add(commandText);
        if (displayOutput) {
          blockBox.add(outputTextNode);
        }

        scrollBox.add(blockBox);
      },
      showWriteOutput: (filePath: string, content: string) => {
        // Reset text node so next text starts fresh after this tool output
        currentTextNode = null;
        currentTextContent = "";

        const blockId = `write-${outputCounter++}`;

        // Create container box with left border (BlockTool pattern)
        const blockBox = new BoxRenderable(renderer, {
          id: blockId,
          flexDirection: "column",
          border: ["left"],
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 2,
          marginTop: 1,
          gap: 1,
          backgroundColor: COLORS.backgroundPanel,
          borderColor: COLORS.background,
        });

        // Title text (muted)
        const titleText = new TextRenderable(renderer, {
          id: `${blockId}-title`,
          content: `# Wrote ${filePath}`,
          fg: COLORS.textMuted,
        });

        blockBox.add(titleText);

        // Show content preview (limited to 10 lines)
        if (content && content.trim()) {
          const lines = content.split("\n");
          const displayLines = lines.slice(0, 10);
          const truncated = lines.length > 10;
          const displayContent = truncated
            ? displayLines.join("\n") + `\n... (${lines.length - 10} more lines)`
            : content;

          const contentText = new TextRenderable(renderer, {
            id: `${blockId}-content`,
            content: displayContent,
            fg: COLORS.text,
            wrapMode: "word",
          });
          blockBox.add(contentText);
        }

        scrollBox.add(blockBox);
      },
      showEditOutput: (filePath: string, diff: string) => {
        // Reset text node so next text starts fresh after this tool output
        currentTextNode = null;
        currentTextContent = "";

        const blockId = `edit-${outputCounter++}`;
        const filetype = getFiletype(filePath);

        // Create container box with left border (BlockTool pattern)
        const blockBox = new BoxRenderable(renderer, {
          id: blockId,
          flexDirection: "column",
          border: ["left"],
          paddingTop: 1,
          paddingBottom: 1,
          paddingLeft: 2,
          marginTop: 1,
          gap: 1,
          backgroundColor: COLORS.backgroundPanel,
          borderColor: COLORS.background,
        });

        // Title text (muted)
        const titleText = new TextRenderable(renderer, {
          id: `${blockId}-title`,
          content: `← Edit ${filePath}`,
          fg: COLORS.textMuted,
        });

        blockBox.add(titleText);

        // Create a DiffRenderable for this edit
        if (diff && diff.trim()) {
          const diffRenderable = new DiffRenderable(renderer, {
            id: `${blockId}-diff`,
            diff: diff,
            view: "unified",
            syntaxStyle,
            filetype,
            showLineNumbers: true,
            addedBg: RGBA.fromHex("#1a3d1a"),
            removedBg: RGBA.fromHex("#3d1a1a"),
            addedSignColor: RGBA.fromHex("#98c379"),
            removedSignColor: RGBA.fromHex("#e06c75"),
            fg: RGBA.fromHex("#e6edf3"),
            width: "100%",
          });
          blockBox.add(diffRenderable);
        }

        scrollBox.add(blockBox);
      },
      setSpinnerActive: (active: boolean) => {
        spinner.visible = active;
      },
    };

    // Handle Enter key on input
    input.on(InputRenderableEvents.ENTER, async () => {
      const intent = input.value?.trim();
      if (!intent || resolved) return;

      // Transition to output view
      inputContainer.visible = false;
      outputContainer.visible = true;
      ui.setStatus(`Bootstrapping workspace for: ${intent}`);

      try {
        await onBootstrap(intent, ui);
        spinner.visible = false;
        ui.setStatus("✓ Bootstrap complete!");
        // Small delay so user can see completion message
        await new Promise((r) => setTimeout(r, 1000));
        cleanup(intent);
      } catch (err) {
        cleanupWithError(err);
      }
    });

    // Handle Ctrl+C
    renderer.keyInput.on("key", (evt) => {
      if (evt.ctrl && evt.name === "c") {
        cleanup(null);
      }
    });

    // Start rendering
    renderer.start();
  });
}
