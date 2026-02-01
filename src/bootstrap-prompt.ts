import {
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
} from "@opentui/core";

export interface BootstrapUI {
  appendOutput: (text: string) => void;
  appendLine: (text: string) => void;
  setStatus: (status: string) => void;
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
    exitOnCtrlC: false,
  });

  return new Promise<string | null>((resolve, reject) => {
    let resolved = false;
    let outputBuffer = "";
    let outputText: TextRenderable;
    let statusText: TextRenderable;
    let scrollBox: ScrollBoxRenderable;
    let inputContainer: BoxRenderable;
    let outputContainer: BoxRenderable;

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
      fg: "#fab283",
    });

    // Create input field
    const input = new InputRenderable(renderer, {
      id: "input",
      height: 1,
      width: 60,
      placeholder: "e.g., managing my personal finances, analyzing data...",
      textColor: "#eeeeee",
      focusedTextColor: "#ffffff",
      cursorColor: "#fab283",
      placeholderColor: "#808080",
    });

    // Create help text
    const helpText = new TextRenderable(renderer, {
      id: "help",
      content: "Press Enter to submit, Ctrl+C to skip",
      fg: "#808080",
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

    // Status line
    statusText = new TextRenderable(renderer, {
      id: "status",
      content: "Bootstrapping...",
      fg: "#fab283",
    });

    // Scrollable output area with sticky scroll to follow new content
    scrollBox = new ScrollBoxRenderable(renderer, {
      id: "scroll",
      flexGrow: 1,
      width: "100%",
      stickyScroll: true,
      stickyStart: "bottom",
    });

    outputText = new TextRenderable(renderer, {
      id: "output",
      content: "",
      fg: "#eeeeee",
      wrapMode: "word",
    });

    scrollBox.add(outputText);
    outputContainer.add(statusText);
    outputContainer.add(scrollBox);

    // Add sections to main container
    container.add(inputContainer);
    container.add(outputContainer);

    // Add container to root
    renderer.root.add(container);

    // Focus the input
    //input.focus();

    // Create UI interface for bootstrap process
    const ui: BootstrapUI = {
      appendOutput: (text: string) => {
        outputBuffer += text;
        outputText.content = outputBuffer;
      },
      appendLine: (text: string) => {
        outputBuffer += text + "\n";
        outputText.content = outputBuffer;
      },
      setStatus: (status: string) => {
        statusText.content = status;
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
        ui.setStatus("Bootstrap complete!");
        // Small delay so user can see completion message
        await new Promise((r) => setTimeout(r, 500));
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
