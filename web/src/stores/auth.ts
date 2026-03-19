import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { trpc } from "../trpc";

type User = { id: string; email: string; mustChangePassword: boolean };

function toAuthErrorMessage(error: unknown, fallback: string) {
  const message = (error as { message?: string })?.message?.trim();
  if (!message) return fallback;

  const lowered = message.toLowerCase();
  const isApiUnavailable =
    lowered.includes("unexpected end of json input") ||
    lowered.includes("failed to execute 'json' on 'response'") ||
    lowered.includes("failed to fetch") ||
    lowered.includes("networkerror") ||
    lowered.includes("network request failed");

  if (isApiUnavailable) {
    return "Failed to reach Sitey API. Is it up and is your network OK?";
  }

  return message;
}

function isUnauthorizedError(error: unknown): boolean {
  const e = error as {
    data?: { code?: string };
    shape?: { data?: { code?: string } };
    message?: string;
  };
  const code = e.data?.code ?? e.shape?.data?.code;
  if (code === "UNAUTHORIZED") return true;
  const message = e.message?.toLowerCase() ?? "";
  return (
    message.includes("not authenticated") || message.includes("unauthorized")
  );
}

export const useAuthStore = defineStore("auth", () => {
  const user = ref<User | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const isAuthenticated = computed(() => !!user.value);
  const needsPasswordChange = computed(
    () => user.value?.mustChangePassword ?? false,
  );

  async function fetchUser() {
    try {
      const me = await trpc.auth.whoami.query();
      user.value = me;
    } catch (e: unknown) {
      if (isUnauthorizedError(e)) {
        user.value = null;
      }
    }
  }

  async function login(email: string, password: string) {
    error.value = null;
    loading.value = true;
    try {
      const res = await trpc.auth.login.mutate({ email, password });
      user.value = {
        id: res.id,
        email: res.email,
        mustChangePassword: res.mustChangePassword,
      };
      return { mustChangePassword: res.mustChangePassword };
    } catch (e: unknown) {
      const msg = toAuthErrorMessage(e, "Login failed");
      error.value = msg;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    error.value = null;
    loading.value = true;
    try {
      await trpc.auth.changePassword.mutate({ currentPassword, newPassword });
      await fetchUser();
    } catch (e: unknown) {
      const msg =
        (e as { message?: string })?.message ?? "Failed to change password";
      error.value = msg;
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function logout() {
    await trpc.auth.logout.mutate().catch(() => {});
    user.value = null;
  }

  return {
    user,
    loading,
    error,
    isAuthenticated,
    needsPasswordChange,
    login,
    changePassword,
    logout,
    fetchUser,
  };
});
