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

/**
 * Share login (RESTRICTED role). Give this out to clients so they can use the embedded
 * prepaid Gemini key WITHOUT the personal admin password. The `share` role can run AI
 * image generation but CANNOT publish / delete R2 (those stay admin-only on the Worker).
 * Bundled = casual deterrence; the prepaid spend cap on the embedded key is the real
 * protection. Rotate by editing this value, then commit + push (auto-redeploys).
 */
export const SHARE_USERNAME = 'share';
export const SHARE_PASSWORD = 'cggs-share-QzvmwX5JxL';
