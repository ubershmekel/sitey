import { router } from '../trpc.js'
import { authRouter } from './auth.js'
import { domainsRouter } from './domains.js'
import { projectsRouter } from './projects.js'
import { deployRouter } from './deploy.js'
import { githubRouter } from './github.js'

export const appRouter = router({
  auth: authRouter,
  domains: domainsRouter,
  projects: projectsRouter,
  deploy: deployRouter,
  github: githubRouter,
})

export type AppRouter = typeof appRouter
