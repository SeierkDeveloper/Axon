// Agent Minds: the models a mind can run on when it thinks through Axon.
//
// A short list, each one tested to answer in the form the rule check reads. Claude runs on Axon's own Anthropic key;
// the others run through OpenRouter (one key, set as OPENROUTER_API_KEY). The prices are what each costs per million
// tokens, in dollars, and are used to hold a thought to its mind's budget before it starts; what a thought really cost
// is taken from the provider's own answer wherever it reports one. No Node imports: the launch screen shows this list.

export interface MindModel {
  id: string;
  label: string;
  maker: string;
  via: "anthropic" | "openrouter";
  inUsd: number;
  outUsd: number;
}

export const MIND_MODELS: readonly MindModel[] = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", maker: "Anthropic", via: "anthropic", inUsd: 4, outUsd: 20 },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", maker: "OpenAI", via: "openrouter", inUsd: 2, outUsd: 10 },
  { id: "x-ai/grok-4.7", label: "Grok 4.7", maker: "xAI", via: "openrouter", inUsd: 2, outUsd: 6 },
  { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash", maker: "Google", via: "openrouter", inUsd: 0.75, outUsd: 3.75 },
  { id: "deepseek/deepseek-v4.1-flash", label: "DeepSeek V4.1", maker: "DeepSeek", via: "openrouter", inUsd: 0.3, outUsd: 1.2 },
];

export const DEFAULT_MIND_MODEL = MIND_MODELS[0].id;

export const mindModel = (id: string | null | undefined): MindModel => MIND_MODELS.find((m) => m.id === id) ?? MIND_MODELS[0];
export const isMindModel = (id: unknown): id is string => typeof id === "string" && MIND_MODELS.some((m) => m.id === id);

/** What a call of this size costs on this model, in dollars. */
export const priceUsd = (m: MindModel, inputTokens: number, outputTokens: number): number => (inputTokens * m.inUsd + outputTokens * m.outUsd) / 1_000_000;

/** A thought is about this big: what is held against a mind's budget before it starts. */
export const THOUGHT_TOKENS = { input: 1_600, output: 900 } as const;
export const estimateThoughtUsd = (m: MindModel): number => priceUsd(m, THOUGHT_TOKENS.input, THOUGHT_TOKENS.output);

/** Can this model be reached with the keys this server has? */
export function modelAvailable(m: MindModel, env: Record<string, string | undefined> = process.env): boolean {
  return Boolean((m.via === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENROUTER_API_KEY)?.trim());
}

/** A mind that runs on its creator's own server instead of one of the models above. */
export const OWN_MIND = "own";
export const OWN_MIND_LABEL = "Its own server";

/** What a token's mind runs on, in words. */
export const mindLabel = (model: string | null | undefined): string => (model === OWN_MIND ? OWN_MIND_LABEL : mindModel(model).label);
