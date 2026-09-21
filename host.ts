// Host worker: the only place that reads or writes Claude credentials.
//
// BB keeps one live Claude Code login per machine. Saving takes a snapshot of
// the Keychain item plus the identity in ~/.claude.json; switching writes a
// snapshot back. Tokens stay in the Keychain on this machine — the server and
// the page only ever see labels, emails, and percentages.

import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./host-contract.js";
import type { Identity, MachineState, SavedAccount } from "./schema.js";
import {
  activateSnapshot,
  activateCredentials,
  claudeCliInstalled,
  deleteSnapshot,
  identityOf,
  parseOauth,
  readActiveCredentialsRaw,
  readActiveIdentity,
  readClaudeJson,
  readSnapshot,
  isExpired,
  readStore,
  refreshActiveCredentials,
  refreshSnapshot,
  withCredentials,
  writeSnapshot,
  writeStore,
} from "./lib/host-credentials.js";
import { fetchUsage } from "./lib/host-usage.js";
import {
  cancelLogin,
  loginState,
  startLogin,
} from "./lib/host-login.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idFor(identity: Identity, fallback: string): string {
  return identity.accountUuid ?? identity.email ?? fallback;
}

function matchesActive(account: SavedAccount, active: Identity | null): boolean {
  if (active === null) return false;
  if (active.accountUuid !== null && account.accountUuid !== null) {
    return account.accountUuid === active.accountUuid;
  }
  return active.email !== null && account.email === active.email;
}

async function currentSnapshot(): Promise<{
  raw: string;
  identity: Identity;
  oauthAccount: Record<string, unknown> | null;
} | null> {
  const raw = await readActiveCredentialsRaw();
  if (raw === null || parseOauth(raw) === null) return null;
  const config = await readClaudeJson();
  const account =
    config !== null && isRecord(config.oauthAccount) ? config.oauthAccount : null;
  const identity =
    account === null
      ? {
          accountUuid: null,
          email: null,
          displayName: null,
          organizationName: null,
          organizationUuid: null,
          subscriptionType: null,
        }
      : identityOf(account);
  return { raw, identity, oauthAccount: account };
}

async function buildState(dataDir: string): Promise<MachineState> {
  const [accounts, active, raw, cliInstalled] = await Promise.all([
    readStore(dataDir),
    readActiveIdentity(),
    readActiveCredentialsRaw(),
    claudeCliInstalled(),
  ]);
  const activeAccount = accounts.find((account) =>
    matchesActive(account, active),
  );
  return {
    active,
    activeId: activeAccount?.id ?? null,
    hasCredentials: parseOauth(raw) !== null,
    cliInstalled,
    accounts: [...accounts].sort((left, right) =>
      left.label.localeCompare(right.label),
    ),
  };
}

/** Stores the machine's current login under `label`, replacing its snapshot. */
async function saveCurrent(
  dataDir: string,
  label: string,
): Promise<SavedAccount> {
  const current = await currentSnapshot();
  if (current === null) {
    throw new Error(
      "No Claude Code login found on this machine. Run `claude /login` first.",
    );
  }
  const accounts = await readStore(dataDir);
  const id = idFor(current.identity, `local-${Date.now()}`);
  const account: SavedAccount = {
    ...current.identity,
    id,
    label,
    savedAt: Date.now(),
  };
  await writeSnapshot(id, {
    credentials: JSON.parse(current.raw) as unknown,
    oauthAccount: current.oauthAccount,
  });
  await writeStore(dataDir, [
    ...accounts.filter((entry) => entry.id !== id),
    account,
  ]);
  return account;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    state: async (_input, context) => buildState(context.experimental_paths.dataDir),

    save: async ({ label }, context) => {
      const account = await saveCurrent(
        context.experimental_paths.dataDir,
        label,
      );
      await context.experimental_emitSignal("changed", { reason: "save" });
      return { account };
    },

    rename: async ({ id, label }, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const accounts = await readStore(dataDir);
      const account = accounts.find((entry) => entry.id === id);
      if (account === undefined) throw new Error(`No saved account "${id}".`);
      const renamed = { ...account, label };
      await writeStore(
        dataDir,
        accounts.map((entry) => (entry.id === id ? renamed : entry)),
      );
      await context.experimental_emitSignal("changed", { reason: "rename" });
      return { account: renamed };
    },

    forget: async ({ id }, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const accounts = await readStore(dataDir);
      if (!accounts.some((entry) => entry.id === id)) return { removed: false };
      await writeStore(
        dataDir,
        accounts.filter((entry) => entry.id !== id),
      );
      await deleteSnapshot(id);
      await context.experimental_emitSignal("changed", { reason: "forget" });
      return { removed: true };
    },

    switchTo: async ({ id }, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const accounts = await readStore(dataDir);
      const target = accounts.find((entry) => entry.id === id);
      if (target === undefined) throw new Error(`No saved account "${id}".`);
      const snapshot = await readSnapshot(id);
      const stored =
        snapshot === null
          ? null
          : parseOauth(JSON.stringify(snapshot.credentials));
      if (snapshot === null || stored === null) {
        throw new Error(
          `The Keychain has no credentials for "${target.label}". Run \`claude /login\` as that account, then Save current.`,
        );
      }
      // Prove the snapshot can still sign in before overwriting the machine's
      // login. Activating a dead snapshot silently logs Claude out.
      let usable = snapshot;
      if (isExpired(stored)) {
        const refreshed = await refreshSnapshot(id, snapshot, context.signal);
        if (refreshed === null) {
          throw new Error(
            `"${target.label}" cannot sign in any more: Anthropic rejected its stored token. Run \`claude /login\` as that account and press Save current. The machine's current login is untouched.`,
          );
        }
        usable = {
          ...snapshot,
          credentials: withCredentials(snapshot.credentials, refreshed),
        };
      }
      // Re-snapshot the login being replaced, always. Claude rotates its
      // tokens while an account is active, so the snapshot taken when it was
      // last saved is dead by now; keeping it would strand that account.
      const active = await readActiveIdentity();
      let savedPrevious = false;
      if (active !== null && !matchesActive(target, active)) {
        const previous = accounts.find((entry) => matchesActive(entry, active));
        savedPrevious = previous === undefined;
        await saveCurrent(
          dataDir,
          previous?.label ?? active.email ?? "Previous login",
        );
      }
      await activateSnapshot(usable);
      await context.experimental_emitSignal("changed", { reason: "switch" });
      return { account: target, savedPrevious };
    },

    usage: async ({ id }, context) => {
      const dataDir = context.experimental_paths.dataDir;
      const accounts = await readStore(dataDir);
      const account = accounts.find((entry) => entry.id === id);
      if (account === undefined) throw new Error(`No saved account "${id}".`);

      // The active account answers from the machine's live credentials, not
      // from its snapshot. If that token aged out between Claude runs,
      // refresh it in place — the same thing Claude Code does on startup.
      const active = await readActiveIdentity();
      if (matchesActive(account, active)) {
        let live = parseOauth(await readActiveCredentialsRaw());
        if (live !== null && isExpired(live)) {
          live = (await refreshActiveCredentials(context.signal)) ?? live;
        }
        if (live !== null && !isExpired(live)) {
          return {
            usage: await fetchUsage(live, account.email, context.signal),
          };
        }
      }

      const snapshot = await readSnapshot(id);
      let credentials =
        snapshot === null
          ? null
          : parseOauth(JSON.stringify(snapshot.credentials));
      if (credentials === null || snapshot === null) {
        return {
          usage: {
            status: "error" as const,
            message:
              "No stored credentials for this account. Switch to it once, then Save current.",
          },
        };
      }
      if (isExpired(credentials)) {
        // An idle snapshot needs a new access token. The refresh rotates the
        // stored pair, so it is persisted at once.
        const refreshed = await refreshSnapshot(id, snapshot, context.signal);
        if (refreshed === null) {
          return { usage: { status: "expired" as const } };
        }
        credentials = refreshed;
      }
      return {
        usage: await fetchUsage(credentials, account.email, context.signal),
      };
    },

    loginStart: async () => startLogin(),

    loginPoll: async (_input, context) => {
      const state = loginState();
      if (state.status === "pending") {
        return {
          status: "pending" as const,
          url: state.url,
          account: null,
          message: null,
        };
      }
      if (state.status === "failed") {
        cancelLogin();
        return {
          status: "failed" as const,
          url: null,
          account: null,
          message: state.message,
        };
      }
      if (state.status === "idle") {
        return {
          status: "idle" as const,
          url: null,
          account: null,
          message: null,
        };
      }
      // The browser came back: make this login the machine's, then store it
      // like any other saved account.
      const dataDir = context.experimental_paths.dataDir;
      const { credentials, oauthAccount, email } = state.outcome;
      cancelLogin();
      await activateCredentials(credentials, oauthAccount);
      const account = await saveCurrent(dataDir, email ?? "New login");
      await context.experimental_emitSignal("changed", { reason: "login" });
      return {
        status: "done" as const,
        url: null,
        account,
        message: null,
      };
    },

    loginCancel: async () => {
      const running = loginState().status === "pending";
      cancelLogin();
      return { cancelled: running };
    },
  },
});
