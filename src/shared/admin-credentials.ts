/**
 * Single source of truth for the admin credentials. Imported by:
 *   - `src/utils/auth.ts`         — frontend AuthGate (login modal)
 *   - `src/worker/index.ts`       — Cloudflare Worker (Basic-Auth on /api/*)
 *
 * Edit the two constants below to rotate credentials, then commit + push;
 * Cloudflare auto-redeploys both the static bundle and the Worker.
 *
 * NOTE: This is bundled into the public JS, so it's deterrence not security.
 * Anyone reading the bundle can see the password. Treat the admin gate as
 * "keep casual visitors out", not "keep determined attackers out". If real
 * security becomes necessary, switch to a custom domain + Cloudflare Access.
 */
export const ADMIN_USERNAME = 'takyu';
export const ADMIN_PASSWORD = '1qaz1833';
