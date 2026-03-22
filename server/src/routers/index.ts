import { router } from "../trpc.ts";
import { authRouter } from "./auth.ts";
import { domainsRouter } from "./domains.ts";
import { projectsRouter } from "./projects.ts";
import { deployRouter } from "./deploy.ts";
import { githubRouter } from "./github.ts";
import { systemRouter } from "./system.ts";

export const appRouter = router({
  auth: authRouter,
  domains: domainsRouter,
  projects: projectsRouter,
  deploy: deployRouter,
  github: githubRouter,
  system: systemRouter,
});

export type AppRouter = typeof appRouter;
