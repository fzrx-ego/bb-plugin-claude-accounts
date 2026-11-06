// Windows stand-in for macOS Keychain: DPAPI-protected files under
// %LOCALAPPDATA%\bb-claude-accounts. Active Claude credentials use the same
// plaintext path Claude Code already uses on Windows
// (~/.claude/.credentials.json) so switches stay interoperable.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STORE_ROOT = path.join(
  process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local"),
  "bb-claude-accounts",
);

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._@-]+/gu, "_").slice(0, 180);
  return cleaned === "" ? "_empty" : cleaned;
}

function secretPath(service: string, account: string): string {
  return path.join(
    STORE_ROOT,
    "secrets",
    `${safeSegment(service)}__${safeSegment(account)}.dpapi`,
  );
}

export function claudeCredentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

// Plaintext never touches the disk: it travels base64-encoded through the
// child's stdin, and the DPAPI result comes back the same way on stdout.
const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$mode = $args[0]
$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$result = if ($mode -eq 'protect') {
  [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
} else {
  [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
}
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

function runDpapi(
  mode: "protect" | "unprotect",
  input: Buffer,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `& { ${DPAPI_SCRIPT} } ${mode}`,
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const stdout: Buffer[] = [];
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 15_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut || code !== 0) {
        reject(new Error(`DPAPI ${mode} failed: ${timedOut ? "timed out" : stderr.trim() || `exit ${code}`}`));
        return;
      }
      const encoded = Buffer.concat(stdout).toString("utf8").trim();
      if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
        reject(new Error(`DPAPI ${mode} returned invalid base64`));
        return;
      }
      resolve(Buffer.from(encoded, "base64"));
    });
    child.stdin.on("error", (cause) => {
      clearTimeout(timer);
      child.kill();
      reject(cause);
    });
    child.stdin.end(input.toString("base64"));
  });
}

export async function readWinSecret(
  service: string,
  account: string,
): Promise<string | null> {
  try {
    const protectedBytes = await readFile(secretPath(service, account));
    const plain = await runDpapi("unprotect", protectedBytes);
    return plain.toString("utf8");
  } catch {
    // Missing file and a failed DPAPI round-trip both read as "no snapshot".
    return null;
  }
}

export async function writeWinSecret(
  service: string,
  account: string,
  value: string,
): Promise<void> {
  const target = secretPath(service, account);
  await mkdir(path.dirname(target), { recursive: true });
  const protectedBytes = await runDpapi("protect", Buffer.from(value, "utf8"));
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, protectedBytes, { mode: 0o600, flag: "wx" });
    await rename(temp, target);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}

export async function deleteWinSecret(
  service: string,
  account: string,
): Promise<boolean> {
  try {
    await unlink(secretPath(service, account));
    return true;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: string }).code === "ENOENT"
    ) {
      return false;
    }
    throw cause;
  }
}

export async function writeClaudeCredentialsFile(value: string): Promise<void> {
  const file = claudeCredentialsPath();
  await mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.credentials-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await writeFile(temp, value, { mode: 0o600 });
    await rename(temp, file);
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}
