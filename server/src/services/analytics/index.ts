/**
 * Analytics background workers entrypoint. Started from the server's main()
 * after bootstrap. Both workers are best-effort and never throw into the
 * process — they no-op cleanly when the Caddy access log doesn't exist yet
 * (fresh install, or dev without Caddy).
 */

import { startAnalyticsIngest } from "./ingest.ts";
import { startAnalyticsPrune } from "./prune.ts";

export function startAnalytics(): void {
  startAnalyticsIngest();
  startAnalyticsPrune();
}
