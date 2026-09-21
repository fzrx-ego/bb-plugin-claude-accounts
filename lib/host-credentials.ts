// Keychain and ~/.claude.json access. Host-worker code only.
//
// Claude Code keeps its OAuth credentials in the login Keychain under
// "Claude Code-credentials" and its identity in ~/.claude.json. A snapshot of
// both is stored under this plugin's own service, "bb-claude-accounts", keyed
// by the account uuid. Switching writes a snapshot back into Claude's own
// item; no token ever leaves the host.

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Identity, SavedAccount } from "../schema";

const execFileAsync = promisify(execFile);

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
export const PLUGIN_KEYCHAIN_SERVICE = "bb-claude-accounts";
const SECURITY_TIMEOUT_MS = 10_000;

export interface ClaudeOauth {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  scopes?: unknown;
}

/** A snapshot as stored in the Keychain: credentials plus the identity. */
export interface Snapshot {
  credentials: unknown;
  oauthAccount: Record<string, unknown> | null;
}

function claudeJsonPath(): string {
  return path.join(os.homedir(), ".claude.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Claude writes hex-encoded blobs on some setups; accept both forms. */
function decodeKeychainValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^(?:[0-9a-f]{2})+$/iu.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "hex").toString("utf8");
    if (decoded.trim().startsWith("{")) return decoded;
  }
  return trimmed;
}

async function security(args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("security", args, {
      timeout: SECURITY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

async function readKeychain(
  service: string,
  account: string | null,
  /** Snapshots must match their account attribute: a service-wide lookup
      would hand back some other saved login. */
  exact = false,
): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const attempts =
    account === null
      ? [["find-generic-password", "-s", service, "-w"]]
      : exact
        ? [["find-generic-password", "-s", service, "-a", account, "-w"]]
        : [
            ["find-generic-password", "-s", service, "-a", account, "-w"],
            ["find-generic-password", "-s", service, "-w"],
          ];
  for (const args of attempts) {
    const stdout = await security(args);
    const decoded = stdout === null ? null : decodeKeychainValue(stdout);
    if (decoded !== null) return decoded;
  }
  return null;
}

async function writeKeychain(
  service: string,
  account: string,
  value: string,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Claude accounts switching is macOS-only.");
  }
  const result = await security([
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    account,
    "-w",
    value,
  ]);
  if (result === null) {
    throw new Error(`Could not write "${service}" to the login Keychain.`);
  }
}

async function deleteKeychain(
  service: string,
  account: string,
): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const result = await security([
    "delete-generic-password",
    "-s",
    service,
    "-a",
    account,
  ]);
  return result !== null;
}

/** Credentials Claude Code is using right now, as stored text. */
export async function readActiveCredentialsRaw(): Promise<string | null> {
  const fromKeychain = await readKeychain(
    CLAUDE_KEYCHAIN_SERVICE,
    os.userInfo().username,
  );
  if (fromKeychain !== null) return fromKeychain;
  try {
    return await readFile(
      path.join(os.homedir(), ".claude", ".credentials.json"),
      "utf8",
    );
  } catch {
    return null;
  }
}

export function parseOauth(raw: string | null): ClaudeOauth | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const oauth = parsed.claudeAiOauth;
    if (!isRecord(oauth) || typeof oauth.accessToken !== "string") return null;
    return oauth as unknown as ClaudeOauth;
  } catch {
    return null;
  }
}

export async function readClaudeJson(): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(claudeJsonPath(), "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readActiveIdentity(): Promise<Identity | null> {
  const config = await readClaudeJson();
  const account = config === null ? null : config.oauthAccount;
  if (!isRecord(account)) return null;
  return identityOf(account);
}

export function identityOf(account: Record<string, unknown>): Identity {
  return {
    accountUuid: stringOrNull(account.accountUuid),
    email: stringOrNull(account.emailAddress),
    displayName: stringOrNull(account.displayName ?? account.fullName),
    organizationName: stringOrNull(account.organizationName),
    organizationUuid: stringOrNull(account.organizationUuid),
    subscriptionType: stringOrNull(account.seatTier ?? account.subscriptionType),
  };
}

/** Writes `oauthAccount` back into ~/.claude.json, keeping every other key. */
export async function writeActiveIdentity(
  oauthAccount: Record<string, unknown>,
): Promise<void> {
  const config = (await readClaudeJson()) ?? {};
  config.oauthAccount = oauthAccount;
  await writeFile(claudeJsonPath(), `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readSnapshot(id: string): Promise<Snapshot | null> {
  const raw = await readKeychain(PLUGIN_KEYCHAIN_SERVICE, id, true);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    // Snapshots written by this plugin wrap both halves; a bare credentials
    // blob (older snapshot, or one copied by hand) still switches.
    if (isRecord(parsed.credentials) || typeof parsed.credentials === "string") {
      const credentials =
        typeof parsed.credentials === "string"
          ? (JSON.parse(parsed.credentials) as unknown)
          : parsed.credentials;
      return {
        credentials,
        oauthAccount: isRecord(parsed.oauthAccount) ? parsed.oauthAccount : null,
      };
    }
    if (isRecord(parsed.claudeAiOauth)) {
      return { credentials: parsed, oauthAccount: null };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeSnapshot(
  id: string,
  snapshot: Snapshot,
): Promise<void> {
  await writeKeychain(
    PLUGIN_KEYCHAIN_SERVICE,
    id,
    JSON.stringify(snapshot),
  );
}

export async function deleteSnapshot(id: string): Promise<boolean> {
  return deleteKeychain(PLUGIN_KEYCHAIN_SERVICE, id);
}

/** Makes `snapshot` the machine's active Claude Code login. */
export async function activateSnapshot(snapshot: Snapshot): Promise<void> {
  await writeKeychain(
    CLAUDE_KEYCHAIN_SERVICE,
    os.userInfo().username,
    JSON.stringify(snapshot.credentials),
  );
  if (snapshot.oauthAccount !== null) {
    await writeActiveIdentity(snapshot.oauthAccount);
  }
}

// ---------------------------------------------------------------------------
// Saved metadata (labels and identities) — the only plugin state on disk.

interface Store {
  version: 1;
  accounts: SavedAccount[];
}

function storePath(dataDir: string): string {
  return path.join(dataDir, "accounts.json");
}

export async function readStore(dataDir: string): Promise<SavedAccount[]> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(storePath(dataDir), "utf8"),
    );
    if (!isRecord(parsed) || !Array.isArray(parsed.accounts)) return [];
    return parsed.accounts.filter(
      (entry): entry is SavedAccount =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.label === "string",
    );
  } catch {
    return [];
  }
}

export async function writeStore(
  dataDir: string,
  accounts: SavedAccount[],
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const store: Store = { version: 1, accounts };
  await writeFile(storePath(dataDir), `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function claudeCliInstalled(): Promise<boolean> {
  const command = process.env.BB_CLAUDE_CODE_EXECUTABLE?.trim() || "claude";
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", [
      command,
    ]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Token refresh.
//
// Access tokens live for hours, refresh tokens for much longer. A saved
// account that has been idle — or an active one whose token aged out between
// Claude runs — needs a new pair before it can answer a usage request.
// Claude Code's own OAuth client issues it. A refresh rotates the pair, so
// the result is written back at once, wherever it came from.

const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Claude Code's public OAuth client (not a user secret). Same id the CLI uses.
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export function isExpired(credentials: ClaudeOauth): boolean {
  return (
    credentials.expiresAt !== null &&
    credentials.expiresAt !== undefined &&
    Date.now() >= credentials.expiresAt
  );
}

/** Trades the refresh token for a new pair. Null when the token is dead. */
export async function refreshCredentials(
  credentials: ClaudeOauth,
  signal?: AbortSignal,
): Promise<ClaudeOauth | null> {
  const refreshToken = credentials.refreshToken;
  if (typeof refreshToken !== "string" || refreshToken === "") return null;
  let payload: Record<string, unknown>;
  try {
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const parsed: unknown = await response.json();
    if (!isRecord(parsed) || typeof parsed.access_token !== "string") {
      return null;
    }
    payload = parsed;
  } catch {
    return null;
  }
  const expiresIn =
    typeof payload.expires_in === "number" ? payload.expires_in : null;
  return {
    ...credentials,
    accessToken: payload.access_token as string,
    refreshToken:
      typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : refreshToken,
    expiresAt: expiresIn === null ? null : Date.now() + expiresIn * 1000,
  };
}

/** Puts `credentials` back into the container they were parsed out of. */
export function withCredentials(
  container: unknown,
  credentials: ClaudeOauth,
): Record<string, unknown> {
  const next = isRecord(container) ? { ...container } : {};
  next.claudeAiOauth = credentials;
  return next;
}

/** Refreshes a saved snapshot in place. */
export async function refreshSnapshot(
  id: string,
  snapshot: Snapshot,
  signal?: AbortSignal,
): Promise<ClaudeOauth | null> {
  const credentials = parseOauth(JSON.stringify(snapshot.credentials));
  if (credentials === null) return null;
  const next = await refreshCredentials(credentials, signal);
  if (next === null) return null;
  await writeSnapshot(id, {
    ...snapshot,
    credentials: withCredentials(snapshot.credentials, next),
  });
  return next;
}

/** Refreshes the machine's live Claude login in place. */
export async function refreshActiveCredentials(
  signal?: AbortSignal,
): Promise<ClaudeOauth | null> {
  const raw = await readActiveCredentialsRaw();
  const credentials = parseOauth(raw);
  if (raw === null || credentials === null) return null;
  const next = await refreshCredentials(credentials, signal);
  if (next === null) return null;
  let container: unknown = null;
  try {
    container = JSON.parse(raw);
  } catch {
    container = null;
  }
  await writeKeychain(
    CLAUDE_KEYCHAIN_SERVICE,
    os.userInfo().username,
    JSON.stringify(withCredentials(container, next)),
  );
  return next;
}

/** Makes a freshly issued login the machine's active Claude Code login. */
export async function activateCredentials(
  credentials: ClaudeOauth,
  oauthAccount: Record<string, unknown>,
): Promise<void> {
  await writeKeychain(
    CLAUDE_KEYCHAIN_SERVICE,
    os.userInfo().username,
    JSON.stringify({ claudeAiOauth: credentials }),
  );
  await writeActiveIdentity(oauthAccount);
}
