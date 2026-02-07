export type BootEvalStruct = {
  inputPath: string;
  model?: string;
  output: {
    skillsPaths: Array<string>;
    agentsMdPath: string;
  };
};

export type FileResult = {
  file: string;
  type: "skill" | "agentsMd";
  llmScores?: Record<string, number>;
  found: boolean;
  content: string | null;
};

export type BootEvalResult = {
  files: FileResult[];
};

export type ProviderConfig = {
  name: string;
  envVar: string;
};

export type ApiKeyResult = {
  providerId: string;
  apiKey: string;
} | null;

export interface BinaryMapping {
  linkName: string;
  target: string;
}
