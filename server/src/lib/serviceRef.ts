/**
 * Service names and references.
 *
 * A service's permanent identity is its numeric id. Names are unique, editable
 * labels. Wherever a client passes a `<service>` reference it may be the
 * current name or the id, written `service-42` or `42`. Names can't take either
 * id form, so the two never collide.
 */

import { z } from "zod";

export const SERVICE_NAME_MAX_LENGTH = 40;

const ID_REF_REGEX = /^(?:service-)?(\d+)$/;

/** Purely numeric, or starting with `service-<digit>`. */
export function isIdLikeServiceName(name: string): boolean {
  return /^\d+$/.test(name) || /^service-\d/.test(name);
}

export const serviceNameSchema = z
  .string()
  .min(1)
  .max(SERVICE_NAME_MAX_LENGTH)
  .regex(/^[a-z0-9-]+$/, "Lowercase alphanumeric and hyphens only")
  .refine(
    (name) => !isIdLikeServiceName(name),
    "Names can't be purely numeric or start with service-<digits> (those are id references)",
  );

export type ServiceRef = { id: number } | { name: string };

export function parseServiceRef(ref: string): ServiceRef {
  const trimmed = ref.trim();
  const match = ID_REF_REGEX.exec(trimmed);
  if (match) return { id: Number(match[1]) };
  return { name: trimmed };
}

export function formatServiceRef(id: number): string {
  return `service-${id}`;
}
