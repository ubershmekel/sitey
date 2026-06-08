/**
 * Shared constants used across server and web.
 *
 * Keep this file dependency-free (no Node-only imports) so the web bundle can
 * import it directly via the relative path into the server source tree.
 */

/**
 * Synthetic analytics service id for traffic with no real user service.
 *
 * The sitey control panel's own traffic normally rolls up under the built-in
 * protected "sitey" service's real id (looked up in caddy.ts), NOT this. This id
 * is used for the two cases where there is no attributable user service:
 *
 *  1. **Requests without service ID** — the fallthrough 404 on a host whose
 *     routes are all path-prefixes (a request that matched no route), and any
 *     line that reaches the ingest worker untagged. Surfaced as "Unknown" in the
 *     analytics UI so the data is visible rather than dropped.
 *  2. **Defensive fallback** — tagging the panel itself if the protected "sitey"
 *     service is somehow missing.
 *
 * Real services autoincrement from 1, so 0 can never collide with one. See
 * docs/design/analytics.md.
 */
export const UNKNOWN_SERVICE_ID = 0;
