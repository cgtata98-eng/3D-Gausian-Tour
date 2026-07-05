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

/** Read the stored auth record, enforcing the TTL. Returns null (and clears the
 *  expired record) when missing / unparseable / expired — the single source of
 *  truth for BOTH `isAuthenticated` and `getAuthRole`, so a stale or corrupt
 *  record can never grant a role. */
function readValidAuthRecord(): AuthRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as AuthRecord;
    if (typeof rec?.ts !== 'number') return null;
    if (Date.now() - rec.ts > AUTH_TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return rec;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return readValidAuthRecord() !== null;
}

export function markAuthenticated(role: AuthRole = 'admin'): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ts: Date.now(), role } satisfies AuthRecord));
  } catch { /* localStorage disabled — best-effort */ }
}

/** Current session role. FAIL-SAFE: a missing / corrupt / expired session yields
 *  the restricted `share` role, never admin. Only a VALID legacy record without a
 *  role field (pre-role admin logins) keeps its historical admin meaning. */
export function getAuthRole(): AuthRole {
  const rec = readValidAuthRecord();
  if (!rec) return 'share';
  return rec.role === 'share' ? 'share' : 'admin';
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
