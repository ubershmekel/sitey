import { router } from "../trpc.ts";
import { authRouter } from "./auth.ts";
import { domainsRouter } from "./domains.ts";
import { servicesRouter } from "./services.ts";
import { deployRouter } from "./deploy.ts";
import { githubRouter } from "./github.ts";
import { systemRouter } from "./system.ts";
import { analyticsRouter } from "./analytics.ts";

export const appRouter = router({
  auth: authRouter,
  domains: domainsRouter,
  services: servicesRouter,
  deploy: deployRouter,
  github: githubRouter,
  system: systemRouter,
  analytics: analyticsRouter,
});

export type AppRouter = typeof appRouter;
