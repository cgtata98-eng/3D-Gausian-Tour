/**
 * AI image-generation model registry (multi-provider).
 *
 * Used by the ⚙ settings model selector and by LeftPanel's image-gen call to pick
 * the provider + upstream model id. The dev proxy (`vite.config.ts` → aiImageProxy)
 * branches on `provider` and forwards to OpenAI images/edits or Gemini generateContent,
 * normalizing both responses to `{ data: [{ b64_json }] }`.
 *
 * NOTE (June 2026): Gemini "Nano Banana" models use the GA ids WITHOUT the `-preview`
 * suffix — the `-preview` ids were shut down 2026-06-25, so never hardcode them.
 * Every OpenAI gpt-image model requires OpenAI **organization verification** (a 403
 * "organization must be verified" otherwise), which is why the shipped default is the
 * Gemini model — it needs only a Google AI Studio key, no org verification.
 */
export type AiProvider = 'openai' | 'gemini';

export interface AiModel {
  /** Internal registry id, e.g. `gemini:gemini-3.1-flash-image`. Stored in localStorage. */
  id: string;
  /** Display label for the selector. */
  label: string;
  provider: AiProvider;
  /** The id sent upstream to the provider API. */
  apiModelId: string;
  recommended: boolean;
}

export const AI_MODELS: AiModel[] = [
  { id: 'gemini:gemini-3.1-flash-image', label: 'Nano Banana 2（高速・推奨）', provider: 'gemini', apiModelId: 'gemini-3.1-flash-image', recommended: true },
  { id: 'gemini:gemini-3-pro-image', label: 'Nano Banana Pro（高品質・最大4K）', provider: 'gemini', apiModelId: 'gemini-3-pro-image', recommended: false },
  { id: 'gemini:gemini-2.5-flash-image', label: 'Nano Banana（旧・低コスト）', provider: 'gemini', apiModelId: 'gemini-2.5-flash-image', recommended: false },
  { id: 'openai:gpt-image-2', label: 'gpt-image-2（要・組織認証）', provider: 'openai', apiModelId: 'gpt-image-2', recommended: false },
  { id: 'openai:gpt-image-1', label: 'gpt-image-1（要・組織認証）', provider: 'openai', apiModelId: 'gpt-image-1', recommended: false },
  { id: 'openai:gpt-image-1-mini', label: 'gpt-image-1-mini（低コスト・要・組織認証）', provider: 'openai', apiModelId: 'gpt-image-1-mini', recommended: false },
];

export const DEFAULT_MODEL_ID = 'gemini:gemini-3.1-flash-image';

/** Resolve a stored registry id to a model, falling back to the default. */
export function getModelById(id: string): AiModel {
  return AI_MODELS.find((m) => m.id === id) ?? AI_MODELS.find((m) => m.id === DEFAULT_MODEL_ID)!;
}

/** Providers shown in the generation UI's provider selector (in display order). */
export const PROVIDERS: { id: AiProvider; label: string }[] = [
  { id: 'gemini', label: 'Gemini' },
  { id: 'openai', label: 'ChatGPT' },
];

export function modelsForProvider(p: AiProvider): AiModel[] {
  return AI_MODELS.filter((m) => m.provider === p);
}

/** First (recommended) model of a provider — used when switching providers. */
export function firstModelForProvider(p: AiProvider): AiModel {
  return AI_MODELS.find((m) => m.provider === p) ?? AI_MODELS[0];
}
