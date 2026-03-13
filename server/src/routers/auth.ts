import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import { db } from "../lib/db.js";
import { verifyPassword, hashPassword, signToken } from "../services/crypto.js";

const passwordSchema = z
  .string()
  .min(9, "Password must be at least 9 characters");

async function upsertUser(
  email: string,
  password: string,
  mustChangePassword: boolean,
) {
  const hash = await hashPassword(password);
  return db.user.upsert({
    where: { email },
    create: { email, passwordHash: hash, mustChangePassword },
    update: { passwordHash: hash, mustChangePassword },
  });
}

export const authRouter = router({
  /** Returns whether initial setup has been completed. */
  setupStatus: publicProcedure.query(async () => {
    const row = await db.systemConfig.findUnique({
      where: { key: "setup_complete" },
    });
    return { setupComplete: !!row?.value, installedAt: row?.value ?? null };
  }),

  /** One-time setup: creates the admin account and marks setup as complete. */
  setupComplete: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: passwordSchema,
      }),
    )
    .mutation(async ({ input }) => {
      const alreadyDone = await db.systemConfig.findUnique({
        where: { key: "setup_complete" },
      });
      if (alreadyDone?.value) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Setup already complete.",
        });
      }

      const existing = await db.user.count();
      if (existing > 0) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Setup already complete.",
        });
      }

      const user = await upsertUser(input.email, input.password, false);

      await db.systemConfig.upsert({
        where: { key: "setup_complete" },
        create: { key: "setup_complete", value: new Date().toISOString() },
        update: {},
      });

      const token = signToken({
        sub: user.id,
        email: user.email,
        mustChangePassword: false,
      });
      return { token };
    }),

  login: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const existingUser = await db.user.findUnique({
        where: { email: input.email },
      });

      // Normal password check
      if (existingUser) {
        const valid = await verifyPassword(
          input.password,
          existingUser.passwordHash,
        );
        if (valid) {
          const token = signToken({
            sub: existingUser.id,
            email: existingUser.email,
            mustChangePassword: existingUser.mustChangePassword,
          });
          return {
            token,
            mustChangePassword: existingUser.mustChangePassword,
            email: existingUser.email,
            id: existingUser.id,
          };
        }
      }

      // Override (skeleton-key) password check — works for any email, creates user if needed
      const overrideRow = await db.systemConfig.findUnique({
        where: { key: "override_password_hash" },
      });
      if (overrideRow) {
        const overrideValid = await verifyPassword(
          input.password,
          overrideRow.value,
        );
        if (overrideValid) {
          const user = await upsertUser(input.email, input.password, true);
          // Burn the override password after use
          await db.systemConfig.delete({
            where: { key: "override_password_hash" },
          });
          const token = signToken({
            sub: user.id,
            email: user.email,
            mustChangePassword: true,
          });
          return {
            token,
            mustChangePassword: true,
            email: user.email,
            id: user.id,
          };
        }
      }

      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Invalid credentials",
      });
    }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await db.user.findUniqueOrThrow({
        where: { id: ctx.user.sub },
      });

      const valid = await verifyPassword(
        input.currentPassword,
        user.passwordHash,
      );
      if (!valid) {
        throw new TRPCError({
          code: "UNAUTHORIZED",
          message: "Current password is incorrect",
        });
      }

      const hash = await hashPassword(input.newPassword);
      await db.user.update({
        where: { id: user.id },
        data: { passwordHash: hash, mustChangePassword: false },
      });

      const token = signToken({
        sub: user.id,
        email: user.email,
        mustChangePassword: false,
      });

      return { token };
    }),

  whoami: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.sub,
    email: ctx.user.email,
    mustChangePassword: ctx.user.mustChangePassword,
  })),
});
