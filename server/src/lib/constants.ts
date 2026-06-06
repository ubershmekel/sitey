/**
 * Shared constants used across server and web.
 *
 * Keep this file dependency-free (no Node-only imports) so the web bundle can
 * import it directly via the relative path into the server source tree.
 */

/**
 * Fallback analytics service id for the sitey control panel.
 *
 * Normally the panel's traffic is tagged with the built-in protected "sitey"
 * service's real id (looked up in caddy.ts), so it rolls up under that service.
 * This synthetic id is only used as a defensive fallback if that protected
 * service is somehow missing — real services autoincrement from 1, so 0 can
 * never collide with one. See docs/design/analytics.md.
 */
export const ADMIN_SERVICE_ID = 0;
