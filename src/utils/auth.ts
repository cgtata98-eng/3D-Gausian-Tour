/**
 * Lightweight client-side authentication for the admin / debug routes.
 *
 * Why a simple shared credential and not Cloudflare Access?
 *   workers.dev URLs are not in our own Cloudflare zone, so Access can't be
 *   applied without a custom domain. This module is the "good enough"
 *   stand-in: it deters casual visitors but is bypassable by anyone willing
 *   to read the JS bundle. Treat it as obscurity, not real security.
 *
 * Change the credentials below when you want to rotate them — push and
 *   redeploy and existing sessions stay valid until they expire (`AUTH_TTL_MS`)
 *   or until you bump `STORAGE_KEY`.
 */

// Credentials live in `src/shared/admin-credentials.ts` so the frontend gate
// and the Worker share a single source of truth.
import { ADMIN_USERNAME, ADMIN_PASSWORD } from '../shared/admin-credentials';

const STORAGE_KEY = 'admin-auth-v1';
/** Session expires after this many ms unless re-authenticated. 7 days. */
const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface AuthRecord {
  /** Unix ms when this auth was granted. */
  ts: number;
}

export function verifyCredentials(username: string, password: string): boolean {
  return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

export function isAuthenticated(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const rec = JSON.parse(raw) as AuthRecord;
    if (typeof rec?.ts !== 'number') return false;
    if (Date.now() - rec.ts > AUTH_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function markAuthenticated(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ts: Date.now() } satisfies AuthRecord));
  } catch { /* localStorage disabled — best-effort */ }
}

export function logout(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}
