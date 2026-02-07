import OpenAI from "openai";
import type { FileResult } from "./types";
import { skillGraderPrompt } from "../../lib/prompts/eval/skill-grader";
import { agentsMdGraderPrompt } from "../../lib/prompts/eval/agents-md-grader";

export async function gradeFile(
  fileResult: FileResult,
): Promise<Record<string, number>> {
  const openai = new OpenAI(); // Uses OPENAI_API_KEY from env

  const prompt =
    fileResult.type === "skill"
      ? skillGraderPrompt(fileResult.content!)
      : agentsMdGraderPrompt(fileResult.content!);

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  // Parse JSON response and extract scores
  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No content in OpenAI response");
  }
  const result = JSON.parse(content);
  return {
    D1: result.dimensions[0].score,
    D2: result.dimensions[1].score,
    D3: result.dimensions[2].score,
    D4: result.dimensions[3].score,
    D5: result.dimensions[4].score,
    total: result.score,
  };
}
