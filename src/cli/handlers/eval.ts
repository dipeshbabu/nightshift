import { join } from "path";
import { mkdirSync } from "fs";
import { bootEval } from "../eval/boot-agent";

export async function runEval(argv: { evalBoot?: boolean; filePath?: string; runs?: number }): Promise<void> {
  if (argv.evalBoot) {
    if (!argv.filePath) {
      throw new Error("filePath is required when evalBoot is true");
    }

    // Read eval config to get model info
    const evalConfig = await Bun.file(argv.filePath).json();
    const model = evalConfig.model || "unknown/unknown";
    const [provider, modelName] = model.includes("/")
      ? model.split("/", 2)
      : ["unknown", model];

    // Create directory structure: ./eval/{provider}/{model}/
    const evalDir = join("./eval", provider, modelName);
    mkdirSync(evalDir, { recursive: true });

    // Run evals
    const runs = argv.runs || 1;
    for (let i = 1; i <= runs; i++) {
      console.log(`Running eval ${i}/${runs}...`);
      const result = await bootEval(argv.filePath);
      const randomId = Math.random().toString(36).substring(2, 8);
      const resultPath = join(evalDir, `boot_eval_result_${i}_${randomId}.json`);
      await Bun.write(resultPath, JSON.stringify(result, null, 2));
      console.log(`Saved: ${resultPath}`);
    }

    console.log(`Completed ${runs} eval run(s)`);
    process.exit(0);
  } else {
    console.error("No eval option specified.");
  }
}
