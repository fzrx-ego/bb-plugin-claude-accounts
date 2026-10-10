// Codex credentials stay on the host. Only account metadata crosses RPC.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { codexAccountSchema, type CodexAccount, type CodexIdentity, type CodexState, type Usage } from "../schema";

const execFileAsync = promisify(execFile);
const SERVICE = "bb-codex-accounts";
const SWIFT_KEYCHAIN_WRITER = String.raw`
import Foundation
import Security
guard CommandLine.arguments.count == 3 else { exit(2) }
let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
let value = FileHandle.standardInput.readDataToEndOfFile()
guard !value.isEmpty else { exit(2) }
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]
var create = query
create[kSecValueData as String] = value
let added = SecItemAdd(create as CFDictionary, nil)
let status = added == errSecDuplicateItem
    ? SecItemUpdate(query as CFDictionary, [kSecValueData as String: value] as CFDictionary)
    : added
guard status == errSecSuccess else {
    fputs("Keychain write failed (OSStatus \(status)).\n", stderr)
    exit(1)
}
`;
const authPath = () => path.join(os.homedir(), ".codex", "auth.json");
const storePath = (dataDir: string) => path.join(dataDir, "codex-accounts.json");

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class UnsupportedCodexLogin extends Error {}

// `account_id` names the ChatGPT workspace, which members of one Team share.
// Snapshots are keyed by it, so two members of one workspace cannot coexist.
const SHARED_WORKSPACE = "This login shares a ChatGPT workspace with another account. " +
  "Switching between members of one ChatGPT workspace is not supported.";
function sameUser(a: string | null, b: string | null): boolean {
  return a === null || b === null || a.toLowerCase() === b.toLowerCase();
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    return record(payload) ? payload : null;
  } catch {
    return null;
  }
}

function identity(raw: string): { id: string; email: string | null } {
  let auth: unknown;
  try { auth = JSON.parse(raw); } catch { throw new UnsupportedCodexLogin("Codex auth.json is invalid JSON."); }
  if (!record(auth) || auth.auth_mode !== "chatgpt" || !record(auth.tokens)) {
    throw new UnsupportedCodexLogin("Only Codex ChatGPT logins can be saved and switched.");
  }
  const tokens = auth.tokens;
  if (typeof tokens.account_id !== "string" || !tokens.account_id ||
      typeof tokens.refresh_token !== "string" || !tokens.refresh_token ||
      typeof tokens.access_token !== "string" || !tokens.access_token) {
    throw new UnsupportedCodexLogin("Codex login is missing account credentials. Run `codex login` first.");
  }
  const claims = typeof tokens.id_token === "string" ? decodeJwt(tokens.id_token) : null;
  const email = typeof claims?.email === "string" ? claims.email : null;
  return { id: tokens.account_id, email };
}

async function live(): Promise<{ raw: string; id: string; email: string | null } | null> {
  let raw: string;
  try { raw = await readFile(authPath(), "utf8"); }
  catch (cause) {
    if (record(cause) && cause.code === "ENOENT") return null;
    throw cause;
  }
  return { raw, ...identity(raw) };
}

async function keychain(args: string[]): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Codex account switching requires macOS Keychain.");
  try {
    return (await execFileAsync("security", args, { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout;
  } catch {
    throw new Error("Could not access Codex account credentials in the login Keychain.");
  }
}

async function readSnapshot(id: string): Promise<string> {
  const value = (await keychain(["find-generic-password", "-s", SERVICE, "-a", id, "-w"])).trim();
  const decoded = /^(?:[0-9a-f]{2})+$/iu.test(value) ? Buffer.from(value, "hex").toString("utf8") : value;
  return decoded.startsWith("codex1:") ? Buffer.from(decoded.slice(7), "base64").toString("utf8") : decoded;
}

async function deleteSnapshot(id: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Codex account switching requires macOS Keychain.");
  try {
    await execFileAsync("security", ["delete-generic-password", "-s", SERVICE, "-a", id], { timeout: 10_000 });
  } catch (cause) {
    // Exit 44 is errSecItemNotFound: the snapshot is already gone, so the label can go too.
    if (record(cause) && cause.code === 44) return;
    throw new Error("Could not access Codex account credentials in the login Keychain.");
  }
}

async function writeSnapshot(id: string, raw: string): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Codex account switching requires macOS Keychain.");
  // `security -w SECRET` exposes tokens in argv; its stdin prompt truncates
  // long values. The small Swift helper writes through Security.framework.
  const value = `codex1:${Buffer.from(raw).toString("base64")}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/swift", ["-e", SWIFT_KEYCHAIN_WRITER, SERVICE, id],
      { stdio: ["pipe", "ignore", "pipe"] });
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { errorOutput = (errorOutput + chunk).slice(-2000); });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", (cause) => { clearTimeout(timer); reject(cause); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Could not save Codex credentials in the login Keychain: ${errorOutput.trim() || `exit ${code}`}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(value);
  });
}

async function readStore(dataDir: string): Promise<CodexAccount[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(storePath(dataDir), "utf8"));
    if (!record(parsed) || !Array.isArray(parsed.accounts)) throw new Error("Invalid Codex account store.");
    return codexAccountSchema.array().parse(parsed.accounts);
  } catch (cause) {
    if (record(cause) && cause.code === "ENOENT") return [];
    throw cause;
  }
}

async function writeStore(dataDir: string, accounts: CodexAccount[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const temp = path.join(dataDir, `.codex-accounts-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify({ version: 1, accounts }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, storePath(dataDir));
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

let mutation = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = mutation.then(work);
  mutation = result.then(() => undefined, () => undefined);
  return result;
}

async function save(dataDir: string, label: string, current: NonNullable<Awaited<ReturnType<typeof live>>>): Promise<CodexAccount> {
  const accounts = await readStore(dataDir);
  const existing = accounts.find((item) => item.id === current.id);
  if (existing && !sameUser(existing.email, current.email)) throw new Error(SHARED_WORKSPACE);
  const account = { id: current.id, email: current.email, label, savedAt: Date.now() };
  await writeSnapshot(current.id, current.raw);
  await writeStore(dataDir, [...accounts.filter((item) => item.id !== current.id), account]);
  return account;
}

async function activateRaw(raw: string): Promise<void> {
  const file = authPath();
  const temp = path.join(path.dirname(file), `.auth-${randomUUID()}.tmp`);
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(temp, raw, { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

/** Activates a completed login. Saving it remains an explicit labelled action. */
export async function codexImportLogin(dataDir: string, raw: string): Promise<CodexIdentity> {
  return serialized(async () => {
    const next = { raw, ...identity(raw) };
    const current = await live();
    const accounts = await readStore(dataDir);
    const saved = accounts.find((item) => item.id === next.id);
    if ((current?.id === next.id && !sameUser(current.email, next.email)) ||
        (saved && !sameUser(saved.email, next.email))) {
      throw new Error(SHARED_WORKSPACE);
    }
    if (current && current.id !== next.id) {
      const outgoing = accounts.find((item) => item.id === current.id);
      if (!outgoing) throw new Error("Save the current Codex login with a label before signing in to another account.");
      await save(dataDir, outgoing.label, current);
    }
    await activateRaw(raw);
    return { id: next.id, email: next.email };
  });
}

export async function codexState(dataDir: string): Promise<CodexState> {
  const accounts = await readStore(dataDir);
  let current: Awaited<ReturnType<typeof live>> = null;
  let activeError: string | null = null;
  try { current = await live(); }
  catch (cause) {
    if (!(cause instanceof UnsupportedCodexLogin)) throw cause;
    activeError = cause.message;
  }
  return { activeId: current?.id ?? null, activeEmail: current?.email ?? null, activeError,
    accounts: accounts.sort((a, b) => a.label.localeCompare(b.label)) };
}

export async function codexSave(dataDir: string, label: string): Promise<CodexAccount> {
  return serialized(async () => {
  const current = await live();
  if (!current) throw new Error("No Codex ChatGPT login found. Run `codex login` first.");
  return save(dataDir, label, current);
  });
}

export async function codexCanStartLogin(dataDir: string): Promise<void> {
  const current = await live();
  if (current !== null && !(await readStore(dataDir)).some((item) => item.id === current.id)) {
    throw new Error("Save the current Codex login with a label before signing in to another account.");
  }
}

export async function codexSwitch(dataDir: string, id: string): Promise<{ account: CodexAccount }> {
  return serialized(async () => {
  const accounts = await readStore(dataDir);
  const target = accounts.find((item) => item.id === id);
  if (!target) throw new Error(`No saved Codex account "${id}".`);
  const raw = await readSnapshot(id);
  if (identity(raw).id !== id) throw new Error("Saved Codex credentials do not match the selected account.");
  const current = await live(); // Refuse to discard an unsupported or damaged login.
  if (current?.id === id) {
    if (!sameUser(current.email, target.email)) throw new Error(SHARED_WORKSPACE);
    return { account: target };
  }
  const outgoing = current === null ? null : accounts.find((item) => item.id === current.id);
  if (current !== null && !outgoing) {
    throw new Error("Save the current Codex login with a label before switching accounts.");
  }
  if (current && outgoing) await save(dataDir, outgoing.label, current);
  // Rename is atomic; mode 0600 keeps the token file private. The isolated
  // BB CODEX_HOME points here through its auth.json symlink.
  await activateRaw(raw);
  return { account: target };
  });
}

export async function codexForget(dataDir: string, id: string): Promise<boolean> {
  return serialized(async () => {
  const accounts = await readStore(dataDir);
  if (!accounts.some((item) => item.id === id)) return false;
  await deleteSnapshot(id);
  await writeStore(dataDir, accounts.filter((item) => item.id !== id));
  return true;
  });
}

/** Reads each saved login's own limits without changing the active login. */
export async function codexUsage(dataDir: string, id: string, signal?: AbortSignal): Promise<Usage> {
  const account = (await readStore(dataDir)).find((item) => item.id === id);
  if (!account) throw new Error(`No saved Codex account "${id}".`);
  let current: Awaited<ReturnType<typeof live>> = null;
  try { current = await live(); }
  catch (cause) {
    if (!(cause instanceof UnsupportedCodexLogin)) throw cause;
  }
  const raw = current?.id === id ? current.raw : await readSnapshot(id);
  if (identity(raw).id !== id) throw new Error("Saved Codex credentials do not match the selected account.");
  const auth = JSON.parse(raw) as { tokens: { access_token: string } };
  const token = auth.tokens.access_token;
  const claims = decodeJwt(token);
  if (typeof claims?.exp === "number" && Date.now() >= claims.exp * 1000) {
    return { status: "expired" };
  }
  const chatGptClaims = record(claims?.["https://api.openai.com/auth"])
    ? claims["https://api.openai.com/auth"] as Record<string, unknown> : null;
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    "chatgpt-account-id": id,
    originator: "bb",
    "User-Agent": "bb-provider-codex",
    Accept: "application/json",
  });
  if (chatGptClaims?.chatgpt_account_is_fedramp === true) {
    headers.set("X-OpenAI-Fedramp", "true");
  }
  try {
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (response.status === 401) return { status: "expired" };
    if (!response.ok) return { status: "error", message: `Codex usage request failed (HTTP ${response.status}).` };
    const result: unknown = await response.json();
    if (!record(result)) return { status: "error", message: "Codex usage response was malformed." };
    const limits = record(result.rate_limit) ? result.rate_limit : null;
    const windows = [
      { value: limits?.primary_window, label: "Current session" },
      { value: limits?.secondary_window, label: "Weekly limit" },
    ].flatMap(({ value, label }) => {
      if (!record(value) || typeof value.used_percent !== "number") return [];
      const reset = typeof value.reset_at === "number" && Number.isFinite(value.reset_at)
        ? new Date(value.reset_at * 1000).toISOString() : null;
      return [{ label, usedPercent: Math.max(0, Math.min(100, Math.round(value.used_percent))), resetsAt: reset }];
    });
    const plan = typeof result.plan_type === "string" ? result.plan_type : null;
    return { status: "ok", accountEmail: account.email, planLabel: plan, windows };
  } catch (cause) {
    return { status: "error", message: cause instanceof Error ? cause.message : String(cause) };
  }
}
