// Browser login through the installed Codex CLI in an isolated CODEX_HOME.
// The live login is committed only after the CLI successfully writes auth.json.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexIdentity } from "../schema";
import { codexCanStartLogin, codexImportLogin } from "./codex-accounts";

type LoginState =
  | { status: "idle" }
  | { status: "pending"; message: string }
  | { status: "done"; account: CodexIdentity }
  | { status: "failed"; message: string };

interface Flow {
  child: ChildProcess;
  directory: string;
  phase: "pending" | "committing" | "finished";
  state: LoginState;
  timer: NodeJS.Timeout;
}

let flow: Flow | null = null;
let starting = false;

export function codexLoginInProgress(): boolean {
  return starting || (flow !== null && flow.phase !== "finished");
}

async function finish(current: Flow, state: LoginState): Promise<void> {
  if (flow !== current) return;
  clearTimeout(current.timer);
  current.phase = "finished";
  current.state = state;
  await rm(current.directory, { recursive: true, force: true });
}

export async function startCodexLogin(dataDir: string): Promise<void> {
  if (codexLoginInProgress()) {
    throw new Error("A Codex sign-in is already running.");
  }
  starting = true;
  try {
  await codexCanStartLogin(dataDir);
  const directory = await mkdtemp(path.join(os.tmpdir(), "bb-codex-login-"));
  const child = spawn("codex", ["login"], {
    env: { ...process.env, CODEX_HOME: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const current: Flow = {
    child,
    directory,
    phase: "pending",
    state: { status: "pending", message: "Approve the Codex sign-in in your browser." },
    timer: setTimeout(() => {
      if (flow !== current || current.phase !== "pending") return;
      child.kill();
      void finish(current, { status: "failed", message: "Codex sign-in timed out." });
    }, 10 * 60_000),
  };
  flow = current;
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => { output = (output + chunk).slice(-4000); });
  }
  child.on("error", (cause) => {
    if (flow === current && current.phase === "pending") {
      void finish(current, { status: "failed", message: `Could not start Codex login: ${cause.message}` });
    }
  });
  child.on("close", (code) => {
    if (flow !== current || current.phase !== "pending") return;
    if (code !== 0) {
      void finish(current, { status: "failed", message: `Codex sign-in failed (exit ${code}). ${output.includes("Operation not permitted") ? "Check that Codex can open the browser on this host." : "Try again."}` });
      return;
    }
    current.phase = "committing";
    current.state = { status: "pending", message: "Saving the new Codex login…" };
    void (async () => {
      try {
        const raw = await readFile(path.join(directory, "auth.json"), "utf8");
        const account = await codexImportLogin(dataDir, raw);
        await finish(current, { status: "done", account });
      } catch (cause) {
        await finish(current, {
          status: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();
  });
  } finally {
    starting = false;
  }
}

export function pollCodexLogin(): LoginState {
  return flow?.state ?? { status: "idle" };
}

export async function cancelCodexLogin(): Promise<boolean> {
  const current = flow;
  if (current === null || current.phase !== "pending") return false;
  flow = null;
  clearTimeout(current.timer);
  current.child.kill();
  await rm(current.directory, { recursive: true, force: true });
  return true;
}
