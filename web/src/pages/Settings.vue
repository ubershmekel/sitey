<template>
  <Layout>
    <div class="page-header">
      <h1>Settings</h1>
    </div>

    <!-- Public Site URL -->
    <section class="settings-section">
      <h2>Public Sitey URL</h2>
      <p class="section-hint">
        Used for GitHub callback URLs, webhook setup links, and admin-facing
        links. This must be publicly reachable.
      </p>

      <div class="meta-row">
        <span class="meta-label">Effective URL (in use)</span>
        <span class="meta-value">{{
          publicSiteUrlInfo?.effectiveUrl ?? "Not configured"
        }}</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Source</span>
        <span class="meta-value">{{ publicUrlSourceLabel }}</span>
      </div>
      <div class="meta-row" v-if="publicSiteUrlInfo?.wildcardUrl">
        <span class="meta-label">Wildcard candidate</span>
        <span class="meta-value">{{ publicSiteUrlInfo.wildcardUrl }}</span>
      </div>
      <p class="section-hint compact" v-if="publicSiteUrlInfo?.wildcardUrl">
        Wildcard candidate is the automatic URL derived from your wildcard
        domain. Effective URL is what Sitey is currently using.
      </p>

      <form
        @submit.prevent="savePublicSiteUrl"
        class="settings-form"
        style="margin-top: 1rem"
      >
        <div v-if="publicSiteUrlError" class="alert error">
          {{ publicSiteUrlError }}
        </div>
        <div v-if="publicSiteUrlSuccess" class="alert success">
          Public Site URL saved.
        </div>
        <label>
          Override URL
          <input
            v-model="publicSiteUrl.value"
            type="text"
            placeholder="https://sitey.example.com"
            autocomplete="off"
          />
        </label>
        <div class="button-row">
          <button
            type="submit"
            class="btn-primary"
            :disabled="publicSiteUrl.saving"
          >
            {{ publicSiteUrl.saving ? "Saving..." : "Save URL" }}
          </button>
          <button
            v-if="publicSiteUrlInfo?.configuredUrl"
            type="button"
            class="btn-ghost"
            :disabled="publicSiteUrl.saving"
            @click="clearPublicSiteUrl"
          >
            Use automatic URL
          </button>
        </div>
      </form>
    </section>

    <section class="settings-section">
      <h2>Users</h2>
      <p class="section-hint">
        Reset generates a temporary password and shows it here. Use "Copy
        password" to copy it to your clipboard.
      </p>

      <div v-if="usersError" class="alert error">{{ usersError }}</div>
      <div v-if="usersSuccess" class="alert success">{{ usersSuccess }}</div>
      <div v-if="generatedPassword" class="alert success">
        {{ generatedPassword.message }}
        <code>{{ generatedPassword.password }}</code>
        <div class="generated-password-actions">
          <button
            type="button"
            class="btn-ghost"
            @click="copyGeneratedPassword"
          >
            {{ generatedPasswordCopied ? "Copied" : "Copy password" }}
          </button>
        </div>
      </div>

      <div class="users-toolbar">
        <button
          type="button"
          class="btn-primary"
          @click="addUserOpen = true"
          :disabled="addUserOpen || addUserLoading"
        >
          Add user
        </button>
      </div>

      <form
        v-if="addUserOpen"
        @submit.prevent="createUser"
        class="settings-form users-add-form"
      >
        <label>
          New user email
          <input
            v-model="addUserEmail"
            type="email"
            required
            autocomplete="email"
          />
        </label>
        <div class="button-row">
          <button type="submit" class="btn-primary" :disabled="addUserLoading">
            {{ addUserLoading ? "Creating..." : "Create user" }}
          </button>
          <button
            type="button"
            class="btn-ghost"
            :disabled="addUserLoading"
            @click="cancelAddUser"
          >
            Cancel
          </button>
        </div>
      </form>

      <div class="user-table" v-if="users.length > 0">
        <div class="user-table-head">
          <span>Email</span>
          <span>Actions</span>
        </div>
        <div v-for="u in users" :key="u.id" class="user-table-row">
          <div class="user-cell">
            <span class="user-row-email">{{ u.email }}</span>
            <span v-if="u.id === auth.user?.id" class="user-row-hint">
              current user
            </span>
          </div>
          <div class="user-actions">
            <button
              type="button"
              class="btn-danger"
              v-if="u.id !== auth.user?.id"
              :disabled="userActionLoadingId === u.id"
              @click="openDeleteConfirm(u)"
            >
              {{
                userActionLoadingId === u.id && userActionKind === "delete"
                  ? "Deleting..."
                  : "Delete user"
              }}
            </button>
            <RouterLink
              v-if="u.id === auth.user?.id"
              to="/change-password"
              class="btn-ghost"
            >
              Change my password
            </RouterLink>
            <button
              type="button"
              class="btn-ghost"
              :disabled="userActionLoadingId === u.id"
              @click="openResetConfirm(u)"
            >
              {{
                userActionLoadingId === u.id && userActionKind === "reset"
                  ? "Resetting..."
                  : "Reset password"
              }}
            </button>
          </div>
        </div>
      </div>
      <p v-else class="section-hint compact">No users yet.</p>
    </section>

    <ConfirmActionModal
      v-model="confirmModalOpen"
      :title="confirmModalTitle"
      :message="confirmModalMessage"
      :confirm-label="confirmModalLabel"
      :danger="confirmAction === 'delete'"
      :loading="confirmModalLoading"
      @confirm="confirmUserAction"
    />

    <!-- Docker disk usage -->
    <section class="settings-section">
      <h2>Docker Disk Usage</h2>
      <p class="section-hint">
        Disk space used by Docker images, container layers, volumes, and build
        cache on this host.
      </p>
      <template v-if="diskUsage">
        <div class="disk-stat-block">
          <div class="disk-bar-wrap">
            <div class="disk-bar" :style="diskBarStyle" />
          </div>
          <p class="disk-bar-label">
            {{ formatBytes(diskUsage.diskTotal - diskUsage.diskAvailable) }}
            used of {{ formatBytes(diskUsage.diskTotal) }} &mdash;
            {{ formatBytes(diskUsage.diskAvailable) }} free
            <span class="disk-bar-path">({{ diskUsage.diskPath }})</span>
          </p>
        </div>
        <div class="disk-usage-grid" style="margin-top: 0.75rem">
          <span class="meta-label">Images</span>
          <span class="meta-value">{{ formatBytes(diskUsage.images) }}</span>
          <span class="meta-label">Containers (writable layers)</span>
          <span class="meta-value">{{
            formatBytes(diskUsage.containers)
          }}</span>
          <span class="meta-label">Volumes</span>
          <span class="meta-value">{{ formatBytes(diskUsage.volumes) }}</span>
          <span class="meta-label">Build cache</span>
          <span class="meta-value">{{
            formatBytes(diskUsage.buildCache)
          }}</span>
        </div>
      </template>
      <p
        v-else-if="diskUsageError"
        class="section-hint"
        style="color: var(--status-err-text)"
      >
        {{ diskUsageError }}
      </p>
      <button
        class="btn-ghost"
        style="margin-top: 0.75rem"
        @click="loadDiskUsage"
        :disabled="diskUsageLoading"
      >
        {{ diskUsageLoading ? "Loading…" : diskUsage ? "Refresh" : "Load" }}
      </button>
    </section>

    <!-- Caddy config debug -->
    <section class="settings-section">
      <h2>Active Caddy config</h2>
      <p class="section-hint">
        The Caddyfile currently pushed to Caddy. Useful for debugging HTTPS /
        routing issues.
      </p>
      <button class="btn-ghost" @click="loadCaddyfile">
        {{ caddyfileLoading ? "Loading…" : "Show config" }}
      </button>
      <pre
        v-if="caddyfile"
        class="block-code"
        style="margin-top: 0.75rem; white-space: pre; overflow-x: auto"
        >{{ caddyfile }}</pre
      >
    </section>

    <!-- Update Sitey -->
    <section class="settings-section">
      <h2>Update Sitey</h2>
      <p class="section-hint">
        Pulls the latest code from git, pulls new Docker images, and restarts
        services. The page will briefly disconnect when the API container
        restarts.
      </p>

      <div v-if="updateError" class="alert error">{{ updateError }}</div>

      <button
        type="button"
        class="btn-primary"
        :disabled="updateRunning"
        @click="triggerUpdate"
      >
        {{ updateRunning ? "Updating…" : "Update Sitey" }}
      </button>

      <pre
        v-if="updateLog.length > 0"
        class="block-code"
        style="
          margin-top: 0.75rem;
          max-height: 400px;
          overflow-y: auto;
          white-space: pre;
          overflow-x: auto;
        "
        >{{ updateLog.join("\n") }}</pre
      >
      <p
        v-if="updateFinishedAt && updateExitCode === 0"
        class="section-hint compact"
        style="margin-top: 0.5rem; color: var(--status-ok-text)"
      >
        Update complete. Reload the page if the UI looks stale.
      </p>
      <p
        v-if="
          updateFinishedAt && updateExitCode !== null && updateExitCode !== 0
        "
        class="section-hint compact"
        style="margin-top: 0.5rem; color: var(--status-err-text)"
      >
        Update failed (exit code {{ updateExitCode }}).
      </p>
    </section>

    <!-- About -->
    <section class="settings-section about">
      <h2>About Sitey</h2>
      <p>
        <a
          href="https://github.com/ubershmekel/sitey/"
          target="_blank"
          rel="noopener noreferrer"
          >GitHub repository</a
        >
      </p>
      <p>
        Self-hosted PaaS. Domain-first. Vibed with ❤️ on TypeScript + Vue 3 +
        Caddy.
      </p>
      <p v-if="versionDisplay" class="hint">{{ versionDisplay }}</p>
      <p v-if="installedAt" class="hint">Installed {{ installedAt }}</p>
      <p class="hint">
        Locked out? To generate an override password, run on the host (probably
        at /opt/sitey/deploy):
      </p>
      <code class="block-code"
        >docker compose exec sitey-api npm run bootstrap:generate-password</code
      >
    </section>
  </Layout>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from "vue";
import { RouterLink } from "vue-router";
import Layout from "../components/Layout.vue";
import ConfirmActionModal from "../components/ConfirmActionModal.vue";
import { trpc } from "../trpc";
import { useAuthStore } from "../stores/auth";

const auth = useAuthStore();
type PublicSiteUrlInfo = Awaited<
  ReturnType<typeof trpc.system.getPublicSiteUrl.query>
>;
type AuthUserList = Awaited<ReturnType<typeof trpc.auth.listUsers.query>>;
type AuthUser = AuthUserList[number];

const publicSiteUrlInfo = ref<PublicSiteUrlInfo | null>(null);
const publicSiteUrl = reactive({ value: "", saving: false });
const publicSiteUrlError = ref("");
const publicSiteUrlSuccess = ref(false);

const publicUrlSourceLabel = computed(() => {
  const source = publicSiteUrlInfo.value?.source;
  if (source === "config") return "Saved override";
  if (source === "wildcard") return "Wildcard domain (sitey.<base>)";
  if (source === "env") return "SITEY_URL environment variable";
  return "Not resolved";
});

async function loadPublicSiteUrl() {
  try {
    const info = await trpc.system.getPublicSiteUrl.query();
    publicSiteUrlInfo.value = info;
    publicSiteUrl.value = info.configuredUrl ?? "";
  } catch (e: unknown) {
    publicSiteUrlError.value =
      (e as { message?: string })?.message ?? "Failed to load Public Site URL.";
  }
}

async function savePublicSiteUrl() {
  publicSiteUrlError.value = "";
  publicSiteUrlSuccess.value = false;
  publicSiteUrl.saving = true;
  try {
    await trpc.system.setPublicSiteUrl.mutate({ url: publicSiteUrl.value });
    publicSiteUrlSuccess.value = true;
    await loadPublicSiteUrl();
  } catch (e: unknown) {
    publicSiteUrlError.value =
      (e as { message?: string })?.message ?? "Failed to save Public Site URL.";
  } finally {
    publicSiteUrl.saving = false;
  }
}

async function clearPublicSiteUrl() {
  publicSiteUrlError.value = "";
  publicSiteUrlSuccess.value = false;
  publicSiteUrl.saving = true;
  try {
    await trpc.system.clearPublicSiteUrl.mutate();
    await loadPublicSiteUrl();
  } catch (e: unknown) {
    publicSiteUrlError.value =
      (e as { message?: string })?.message ??
      "Failed to clear Public Site URL.";
  } finally {
    publicSiteUrl.saving = false;
  }
}

const versionDisplay = ref<string | null>(null);
async function loadVersion() {
  try {
    const v = await trpc.system.getVersion.query();
    if (v.hash) {
      const date = v.timestamp ? v.timestamp.slice(0, 10) : "";
      versionDisplay.value = `Version: ${v.hash}${date ? ` · ${date}` : ""}`;
    }
  } catch {
    console.warn("Failed to load version");
  }
}

const installedAt = ref<string | null>(null);
async function loadInstalledAt() {
  try {
    const status = await trpc.auth.setupStatus.query();
    installedAt.value = status.installedAt ?? null;
  } catch {
    console.warn("Failed to load installedAt");
  }
}

const users = ref<AuthUser[]>([]);
const usersError = ref("");
const usersSuccess = ref("");
const addUserOpen = ref(false);
const addUserLoading = ref(false);
const addUserEmail = ref("");
const userActionLoadingId = ref<string | null>(null);
const userActionKind = ref<"reset" | "delete" | null>(null);
const generatedPassword = ref<{
  email: string;
  password: string;
  message: string;
} | null>(null);
const generatedPasswordCopied = ref(false);
const confirmModalOpen = ref(false);
const confirmAction = ref<"reset" | "delete" | null>(null);
const confirmTargetUser = ref<AuthUser | null>(null);

const confirmModalTitle = computed(() => {
  if (confirmAction.value === "reset") return "Reset user password?";
  if (confirmAction.value === "delete") return "Delete user?";
  return "Confirm action";
});

const confirmModalMessage = computed(() => {
  const email = confirmTargetUser.value?.email ?? "this user";
  if (confirmAction.value === "reset") {
    return `A new temporary password will be generated for ${email}. Continue?`;
  }
  if (confirmAction.value === "delete") {
    return `${email} will be permanently removed. Continue?`;
  }
  return "Continue?";
});

const confirmModalLabel = computed(() => {
  if (confirmAction.value === "reset") return "Reset password";
  if (confirmAction.value === "delete") return "Delete user";
  return "Confirm";
});

const confirmModalLoading = computed(() => {
  return (
    !!confirmTargetUser.value &&
    userActionLoadingId.value === confirmTargetUser.value.id
  );
});

async function loadUsers() {
  usersError.value = "";
  try {
    users.value = await trpc.auth.listUsers.query();
  } catch (e: unknown) {
    usersError.value =
      (e as { message?: string })?.message ?? "Failed to load users";
  }
}

async function copyPassword(password: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(password);
    return true;
  } catch {
    return false;
  }
}

async function copyGeneratedPassword() {
  if (!generatedPassword.value) return;
  const copied = await copyPassword(generatedPassword.value.password);
  generatedPasswordCopied.value = copied;
}

function cancelAddUser() {
  addUserOpen.value = false;
  addUserEmail.value = "";
}

function openResetConfirm(user: AuthUser) {
  confirmAction.value = "reset";
  confirmTargetUser.value = user;
  confirmModalOpen.value = true;
}

function openDeleteConfirm(user: AuthUser) {
  if (user.id === auth.user?.id) {
    usersError.value = "You cannot delete your own user.";
    return;
  }
  confirmAction.value = "delete";
  confirmTargetUser.value = user;
  confirmModalOpen.value = true;
}

async function confirmUserAction() {
  const user = confirmTargetUser.value;
  const action = confirmAction.value;
  if (!user || !action) return;

  if (action === "reset") {
    await resetUserPassword(user);
  } else {
    await deleteUser(user);
  }

  confirmModalOpen.value = false;
  confirmTargetUser.value = null;
  confirmAction.value = null;
}

async function createUser() {
  usersError.value = "";
  usersSuccess.value = "";
  generatedPassword.value = null;
  generatedPasswordCopied.value = false;
  const email = addUserEmail.value.trim();
  if (!email) {
    usersError.value = "Email is required";
    return;
  }

  addUserLoading.value = true;
  try {
    const result = await trpc.auth.createUser.mutate({
      email,
      mustChangePassword: false,
    });
    generatedPassword.value = result.generatedPassword
      ? {
          email: result.email,
          password: result.generatedPassword,
          message: `User added for ${result.email}. Temporary password:`,
        }
      : null;
    generatedPasswordCopied.value = false;
    usersSuccess.value = "";
    cancelAddUser();
    await loadUsers();
  } catch (e: unknown) {
    usersError.value =
      (e as { message?: string })?.message ?? "Failed to add user";
  } finally {
    addUserLoading.value = false;
  }
}

async function resetUserPassword(user: AuthUser) {
  usersError.value = "";
  usersSuccess.value = "";
  generatedPassword.value = null;
  generatedPasswordCopied.value = false;
  userActionLoadingId.value = user.id;
  userActionKind.value = "reset";
  try {
    const result = await trpc.auth.resetUserPassword.mutate({
      userId: user.id,
    });
    generatedPassword.value = {
      email: result.email,
      password: result.generatedPassword,
      message: `Password reset for ${result.email}. Temporary password:`,
    };
    generatedPasswordCopied.value = false;
    usersSuccess.value = "";
    await loadUsers();
  } catch (e: unknown) {
    usersError.value =
      (e as { message?: string })?.message ?? "Failed to reset password";
  } finally {
    userActionLoadingId.value = null;
    userActionKind.value = null;
  }
}

async function deleteUser(user: AuthUser) {
  usersError.value = "";
  usersSuccess.value = "";
  generatedPassword.value = null;
  generatedPasswordCopied.value = false;
  userActionLoadingId.value = user.id;
  userActionKind.value = "delete";
  try {
    await trpc.auth.deleteUser.mutate({ userId: user.id });
    usersSuccess.value = `Deleted ${user.email}.`;
    await loadUsers();
  } catch (e: unknown) {
    usersError.value =
      (e as { message?: string })?.message ?? "Failed to delete user";
  } finally {
    userActionLoadingId.value = null;
    userActionKind.value = null;
  }
}

type DiskUsage = Awaited<ReturnType<typeof trpc.system.getDiskUsage.query>>;
const diskUsage = ref<DiskUsage | null>(null);
const diskUsageLoading = ref(false);
const diskUsageError = ref("");

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const diskBarStyle = computed(() => {
  if (!diskUsage.value || diskUsage.value.diskTotal === 0) return {};
  const pct = Math.round(
    ((diskUsage.value.diskTotal - diskUsage.value.diskAvailable) /
      diskUsage.value.diskTotal) *
      100,
  );
  const color =
    pct >= 85
      ? "var(--status-err-text)"
      : pct >= 70
        ? "var(--status-warn-text)"
        : "var(--brand)";
  return { width: `${pct}%`, background: color };
});

async function loadDiskUsage() {
  diskUsageLoading.value = true;
  diskUsageError.value = "";
  try {
    diskUsage.value = await trpc.system.getDiskUsage.query();
  } catch (e: unknown) {
    diskUsageError.value =
      (e as { message?: string })?.message ?? "Failed to load disk usage.";
  } finally {
    diskUsageLoading.value = false;
  }
}

const caddyfile = ref("");
const caddyfileLoading = ref(false);

async function loadCaddyfile() {
  caddyfileLoading.value = true;
  try {
    caddyfile.value = await trpc.domains.getCaddyfile.query();
  } finally {
    caddyfileLoading.value = false;
  }
}

// ── Update Sitey ─────────────────────────────────────────────────────────────

const updateRunning = ref(false);
const updateLog = ref<string[]>([]);
const updateError = ref("");
const updateExitCode = ref<number | null>(null);
const updateFinishedAt = ref<string | null>(null);
let updatePollInterval: ReturnType<typeof setInterval> | null = null;

async function triggerUpdate() {
  updateError.value = "";
  updateLog.value = [];
  updateExitCode.value = null;
  updateFinishedAt.value = null;
  try {
    await trpc.system.triggerUpdate.mutate();
    updateRunning.value = true;
    startUpdatePolling();
  } catch (e: unknown) {
    updateError.value =
      (e as { message?: string })?.message ?? "Failed to start update.";
  }
}

async function pollUpdateStatus() {
  try {
    const status = await trpc.system.getUpdateStatus.query();
    updateRunning.value = status.running;
    updateLog.value = status.log;
    updateExitCode.value = status.exitCode;
    updateFinishedAt.value = status.finishedAt;
    if (!status.running) stopUpdatePolling();
  } catch {
    // API may be restarting — keep polling silently
  }
}

function startUpdatePolling() {
  updatePollInterval = setInterval(pollUpdateStatus, 2000);
}

function stopUpdatePolling() {
  if (updatePollInterval) {
    clearInterval(updatePollInterval);
    updatePollInterval = null;
  }
}

onUnmounted(() => stopUpdatePolling());

onMounted(() => {
  loadPublicSiteUrl();
  loadVersion();
  loadInstalledAt();
  loadUsers();
  // Resume polling if an update was already in progress
  trpc.system.getUpdateStatus
    .query()
    .then((s) => {
      if (s.running) {
        updateRunning.value = true;
        updateLog.value = s.log;
        startUpdatePolling();
      }
    })
    .catch(() => {});
});
</script>

<style scoped>
.page-header {
  margin-bottom: 2rem;
}

h1 {
  font-weight: 600;
}

.settings-section {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 1.75rem;
  margin-bottom: 1.5rem;
}

.settings-section h2 {
  font-size: var(--font-medium);
  font-weight: 600;
  margin-bottom: 1rem;
}

.section-hint {
  font-size: var(--font-tiny);
  margin-bottom: 1.25rem;
  margin-top: -0.5rem;
}

.meta-row {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  align-items: start;
  gap: 1rem;
  margin-bottom: 0.35rem;
  font-size: var(--font-tiny);
}

.meta-value {
  font-family: monospace;
  word-break: break-all;
  text-align: left;
}

.section-hint.compact {
  margin-top: 0.5rem;
  margin-bottom: 0;
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 480px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

input,
textarea {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
  outline: none;
  transition: border-color 0.15s;
  font-family: inherit;
}

input:focus,
textarea:focus {
  border-color: var(--brand);
}

textarea {
  resize: vertical;
  font-family: monospace;
  font-size: var(--font-tiny);
}

.form-row {
  display: flex;
  gap: 0.75rem;
}

.button-row {
  display: flex;
  gap: 0.75rem;
  align-items: center;
}

.settings-form > .btn-primary {
  align-self: flex-start;
}

.users-toolbar {
  margin-top: 1rem;
  margin-bottom: 1rem;
}

.generated-password-actions {
  margin-top: 0.75rem;
}

.users-add-form {
  margin-bottom: 1rem;
}

.user-table {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  overflow: hidden;
}

.user-table-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  padding: 0.65rem 0.75rem;
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--border-default);
  font-size: var(--font-tiny);
  color: var(--text-muted);
}

.user-table-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem;
  padding: 0.75rem;
  border-bottom: 1px solid var(--border-default);
}

.user-table-row:last-child {
  border-bottom: none;
}

.user-cell {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.user-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.user-row-email {
  color: var(--text-primary);
  font-size: var(--font-medium);
  word-break: break-all;
}

.user-row-hint {
  font-size: var(--font-tiny);
  color: var(--status-warn-text);
}

.app-status {
  margin-bottom: 1rem;
}

.badge {
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
}

.badge-ok {
  background: var(--status-ok-bg);
  color: var(--status-ok-text);
}

.badge-warn {
  background: var(--status-warn-bg);
  color: var(--status-warn-text);
}

.btn-danger {
  background: var(--status-err-bg);
  color: var(--status-err-text);
  border: none;
  border-radius: 6px;
  padding: 0.6rem 1.25rem;
  cursor: pointer;
  transition: background 0.15s;
}

.btn-danger:hover {
  background: #7a2020;
}

.alert {
  border-radius: 6px;
  padding: 0.6rem 0.75rem;
}

.alert.error {
  background: var(--status-err-bg);
  border: 1px solid var(--status-err-border);
  color: var(--status-err-text);
}

.alert.success {
  background: var(--status-ok-bg);
  border: 1px solid var(--status-ok-border);
  color: var(--status-ok-text);
}

.section-hint.warn {
  color: var(--status-warn-text);
  background: var(--status-warn-bg);
  border: 1px solid var(--status-warn-border);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
}

.section-hint.warn code {
  background: #2a2200;
  border-radius: 3px;
  padding: 0.1em 0.3em;
}

.section-hint a {
  color: var(--brand);
}

.domain-select-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}

.domain-label {
  white-space: nowrap;
}

.domain-select {
  background: var(--bg-input);
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0.45rem 0.6rem;
  flex: 1;
}

.auto-form {
  margin-bottom: 1.25rem;
}

.manual-details {
  margin-top: 1rem;
}

.manual-details summary {
  font-size: var(--font-tiny);
  cursor: pointer;
  user-select: none;
}

.btn-sm {
  padding: 0.25rem 0.6rem;
  font-size: var(--font-tiny);
}

.disk-stat-block {
  max-width: 480px;
}

.disk-bar-wrap {
  height: 8px;
  background: var(--border-default);
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.disk-bar {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}

.disk-bar-label {
  font-size: var(--font-tiny);
  color: var(--text-muted);
  margin: 0;
}

.disk-bar-path {
  opacity: 0.6;
  font-family: monospace;
}

.disk-usage-grid {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 0.35rem 1rem;
  font-size: var(--font-tiny);
}

.about p {
  font-size: var(--font-tiny);
  margin-bottom: 0.5rem;
}

.block-code {
  display: block;
  background: var(--bg-code);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  font-family: monospace;
  color: var(--status-ok-text);
  margin-top: 0.5rem;
  word-break: break-all;
}
</style>
