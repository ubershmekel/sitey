import { initTRPC, TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires a valid JWT. Injects user into ctx. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

/** Requires auth AND completed password change. */
export const settledProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.mustChangePassword) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You must change your password before using the API.",
    });
  }
  return next({ ctx });
});
