/**
 * Client-side storage for user-provided API keys + selected AI model (authoring /
 * Debug side only).
 *
 * Keys are entered via the ⚙ settings button (see `ui/ApiKeySettings.tsx`) and sent to
 * the dev `/api/ai/edit` proxy through provider-specific headers: OpenAI via
 * `X-OpenAI-Key`, Gemini via `X-Gemini-Key`. The proxy prefers the header over the
 * server-side `.env.local` fallback (`OPENAI_API_KEY` / `GEMINI_API_KEY`). Stored in
 * localStorage so they persist across reloads on this machine.
 *
 * NOTE: this is for the personal authoring tool — keys live in the browser of the
 * person running the editor, never shipped to the customer viewer.
 */
import { AI_MODELS, DEFAULT_MODEL_ID } from './ai-models';

const OPENAI_KEY_LS = '3dcggs:openai-api-key';
const GEMINI_KEY_LS = '3dcggs:gemini-api-key';
const MODEL_LS = '3dcggs:ai-model';

function readLS(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeLS(key: string, value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) localStorage.setItem(key, trimmed);
    else localStorage.removeItem(key);
  } catch {
    /* ignore — private mode / storage disabled */
  }
}

/** Notify same-tab listeners (the generation UI) that keys / selected model changed.
 *  localStorage's native 'storage' event only fires cross-tab, so we dispatch our own. */
function notifyAiConfigChange(): void {
  try { window.dispatchEvent(new Event('aiconfig-change')); } catch { /* ignore (SSR) */ }
}

export function getOpenAIKey(): string { return readLS(OPENAI_KEY_LS); }
export function setOpenAIKey(key: string): void { writeLS(OPENAI_KEY_LS, key); notifyAiConfigChange(); }

export function getGeminiKey(): string { return readLS(GEMINI_KEY_LS); }
export function setGeminiKey(key: string): void { writeLS(GEMINI_KEY_LS, key); notifyAiConfigChange(); }

/** Selected model registry id. Falls back to the default if unset / unknown. */
export function getSelectedModelId(): string {
  const id = readLS(MODEL_LS);
  return AI_MODELS.some((m) => m.id === id) ? id : DEFAULT_MODEL_ID;
}
export function setSelectedModelId(id: string): void {
  try { localStorage.setItem(MODEL_LS, id); } catch { /* ignore */ }
  notifyAiConfigChange();
}
