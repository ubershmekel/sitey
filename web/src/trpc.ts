import { createTRPCClient, httpBatchLink } from "@trpc/client";
import type { AppRouter } from "../../server/src/routers/index";

const getBaseUrl = () => {
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  return ""; // same origin, proxied via vite in dev
};

export const trpc = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${getBaseUrl()}/trpc`,
      headers() {
        const token = localStorage.getItem("sitey_token");
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});
