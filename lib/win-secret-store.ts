// Windows stand-in for macOS Keychain: DPAPI-protected files under
// %LOCALAPPDATA%\bb-claude-accounts. Active Claude credentials use the same
// plaintext path Claude Code already uses on Windows
// (~/.claude/.credentials.json) so switches stay interoperable.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
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

async function runDpapi(
  mode: "protect" | "unprotect",
  input: Buffer,
): Promise<Buffer> {
  await mkdir(path.join(STORE_ROOT, "tmp"), { recursive: true });
  const inFile = path.join(
    STORE_ROOT,
    "tmp",
    `in-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`,
  );
  const outFile = `${inFile}.out`;
  try {
    await writeFile(inFile, input, { mode: 0o600 });
    const script = `
Add-Type -AssemblyName System.Security
$mode = '${mode}'
$inPath = '${inFile.replace(/'/gu, "''")}'
$outPath = '${outFile.replace(/'/gu, "''")}'
$bytes = [System.IO.File]::ReadAllBytes($inPath)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$result = if ($mode -eq 'protect') {
  [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
} else {
  [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
}
[System.IO.File]::WriteAllBytes($outPath, $result)
`;
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { timeout: 15_000, windowsHide: true },
    );
    return await readFile(outFile);
  } finally {
    await unlink(inFile).catch(() => undefined);
    await unlink(outFile).catch(() => undefined);
  }
}

export async function readWinSecret(
  service: string,
  account: string,
): Promise<string | null> {
  try {
    const protectedBytes = await readFile(secretPath(service, account));
    const plain = await runDpapi("unprotect", protectedBytes);
    return plain.toString("utf8");
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      (cause as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
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
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temp, protectedBytes, { mode: 0o600 });
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
