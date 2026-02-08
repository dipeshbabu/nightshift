import yargs from "yargs";
import { renderBirdBanner } from "./lib/banner";
import { getNightshiftVersion } from "./lib/constants";
import { resolvePrefixFromConfig, saveActivePrefix } from "./lib/config";
import { createWorkspace, installTools } from "./cli/handlers/install";
import { run, resolveRunOptions, buildAttachTuiArgs, type RalphOptions } from "./cli/handlers/run";
import { runEval } from "./cli/handlers/eval";
import { upgrade } from "./cli/handlers/upgrade";

function installCompleteMessage() {
  console.log("Instalation complete")
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    renderBirdBanner();
  }

  yargs(args)
    .command(
      "install",
      "Install opencode + tools into a prefix",
      (y) =>
        y.option("prefix", {
          type: "string",
          demandOption: true,
          describe: "Directory to install tools into",
        })
          .option("skip-ai-boot", {
            type: "boolean",
            default: false,
            describe: "Skip the Boot Agent routine"

          })
      ,
      async (argv) => {
        try {
          const { skipAgentBoot } = resolveRunOptions(argv, process.argv);
          // install routine
          // install tools to prefix
          await installTools(argv.prefix);
          // create workspace in prefix
          await createWorkspace(argv.prefix);
          // if we're skipping the Boot Agent Routine, it's safe to return
          if (skipAgentBoot) {
            console.log("Skipping Boot Agent Sequence");
            installCompleteMessage()
            process.exit(0);
          }
          // we're not skipping agent routine, start the Boot Agent Routine
          // TODO: implement Boot Agent Routine

        } catch (err) {
          console.error("Install failed:", err);
          process.exit(1);
        }
      },
    )
    .command(
      "run",
      "Launch opencode with isolated env",
      (y) =>
        y
          .option("prefix", {
            type: "string",
            describe: "Prefix where tools are installed (defaults to nightshift.json)",
          })
          .option("run-nightshift-tui", {
            type: "boolean",
            default: false,
            describe: "Use Nightshift TUI instead of default opencode",
          })
          .option("sandbox", {
            type: "boolean",
            default: false,
            describe: "Run in sandbox mode (read-only host filesystem, writable workspace)",
          })
          .option("ralph", {
            type: "boolean",
            default: false,
            describe: "Run in executor/validator loop mode",
          })
          .option("prompt", {
            type: "string",
            describe: "Path to prompt file for ralph mode",
          })
          .option("agent-model", {
            type: "string",
            default: "openai/gpt-5.2-codex",
            describe: "Model for executor in ralph mode",
          })
          .option("eval-model", {
            type: "string",
            default: "openai/gpt-5.2-codex",
            describe: "Model for validator in ralph mode",
          }),
      async (argv) => {
        try {
          const { extra, useNightshiftTui, sandboxEnabled, ralphEnabled, ralphPrompt, ralphAgentModel, ralphEvalModel } = resolveRunOptions(argv, process.argv);
          const ralphOptions: RalphOptions | undefined = ralphEnabled
            ? { enabled: true, prompt: ralphPrompt, agentModel: ralphAgentModel, evalModel: ralphEvalModel, useNightshiftTui }
            : undefined;

          if (argv.prefix) {
            await saveActivePrefix(argv.prefix);
            await run(argv.prefix, extra, useNightshiftTui, sandboxEnabled, ralphOptions);
            return;
          }

          const resolved = await resolvePrefixFromConfig(process.cwd());
          console.log(`Using prefix from ${resolved.source}`);
          await run(resolved.prefix, extra, useNightshiftTui, sandboxEnabled, ralphOptions);
        } catch (err) {
          console.error("Run failed:", err);
          process.exit(1);
        }
      },
    )
    .command(
      "$0",
      "Launch opencode using nightshift.json",
      (y) =>
        y
          .option("run-nightshift-tui", {
            type: "boolean",
            default: false,
            describe: "Use Nightshift TUI instead of default opencode",
          })
          .option("sandbox", {
            type: "boolean",
            default: false,
            describe: "Run in sandbox mode (read-only host filesystem, writable workspace)",
          }),
      async (argv) => {
        try {
          const { extra, useNightshiftTui, sandboxEnabled } = resolveRunOptions(argv, process.argv);
          const resolved = await resolvePrefixFromConfig(process.cwd());
          console.log(`Using prefix from ${resolved.source}`);
          await run(resolved.prefix, extra, useNightshiftTui, sandboxEnabled);
        } catch (err) {
          console.error("Run failed:", err);
          process.exit(1);
        }
      }
    )
    .command(
      "attach <url>",
      "Attach to a running opencode server",
      (y) =>
        y
          .positional("url", {
            type: "string",
            demandOption: true,
            describe: "URL of the opencode server (e.g., http://localhost:4096)",
          })
          .option("session", {
            alias: "s",
            type: "string",
            describe: "Session ID to continue",
          }),
      async (argv) => {
        try {
          const { tui } = await import("./tui/tui/app");
          await tui(buildAttachTuiArgs(argv.url!, argv.session, process.cwd()));
        } catch (err) {
          console.error("Attach failed:", err);
          process.exit(1);
        }
      },
    )
    .command(
      "eval",
      "Evaluate the agent",
      (y) =>
        y
          .option("evalBoot", {
            type: "boolean",
            default: false,
            describe: "Evaluate the bootstrap process",
          })
          .option("filePath", {
            type: "string",
            describe: "Path to the eval file",
          })
          .option("runs", {
            type: "number",
            default: 1,
            describe: "Number of times to run the evaluation",
          }),
      async (argv) => {
        try {
          await runEval(argv);
        } catch (err) {
          console.error("Eval failed:", err);
          process.exit(1);
        }
      },
    )
    .command(
      "upgrade",
      "Upgrade nightshift to the latest version",
      (y) =>
        y.option("force", {
          alias: "f",
          type: "boolean",
          default: false,
          describe: "Force upgrade even if already at latest version",
        }),
      async (argv) => {
        try {
          await upgrade({ force: argv.force });
        } catch (err) {
          console.error("Upgrade failed:", err);
          process.exit(1);
        }
      },
    )
    .demandCommand(1, "Please specify a command: install, run, or attach")
    .strict()
    .scriptName("nightshift")
    .help()
    .version(getNightshiftVersion())
    .usage("Usage: nightshift <command> [options]")
    .parse();
}
