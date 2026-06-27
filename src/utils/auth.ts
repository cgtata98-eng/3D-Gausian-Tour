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
import { ADMIN_USERNAME, ADMIN_PASSWORD, SHARE_USERNAME, SHARE_PASSWORD } from '../shared/admin-credentials';

const STORAGE_KEY = 'admin-auth-v1';
/** Session expires after this many ms unless re-authenticated. 7 days. */
const AUTH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** `admin` = full access. `share` = restricted (AI image gen only; no publish / R2). */
export type AuthRole = 'admin' | 'share';

interface AuthRecord {
  /** Unix ms when this auth was granted. */
  ts: number;
  /** Which credential logged in. Legacy records (no role) are treated as admin. */
  role?: AuthRole;
}

/** Returns the matched role, or null when the credentials are invalid. */
export function verifyCredentials(username: string, password: string): AuthRole | null {
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) return 'admin';
  if (username === SHARE_USERNAME && password === SHARE_PASSWORD) return 'share';
  return null;
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

export function markAuthenticated(role: AuthRole = 'admin'): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ts: Date.now(), role } satisfies AuthRecord));
  } catch { /* localStorage disabled — best-effort */ }
}

/** Current session role. Legacy sessions without a role default to admin. */
export function getAuthRole(): AuthRole {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 'admin';
    const rec = JSON.parse(raw) as AuthRecord;
    return rec?.role === 'share' ? 'share' : 'admin';
  } catch {
    return 'admin';
  }
}

/** Basic Auth header for the current session role — sent to the Worker so it can tell
 *  admin (publish + AI) from share (AI only). */
export function getAuthHeader(): string {
  return getAuthRole() === 'share'
    ? 'Basic ' + btoa(`${SHARE_USERNAME}:${SHARE_PASSWORD}`)
    : 'Basic ' + btoa(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`);
}

export function logout(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}
