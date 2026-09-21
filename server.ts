// bb-plugin-claude-accounts — backend entry.
//
// The server owns no credentials. It forwards page RPC and `bb
// claude-accounts` CLI calls to the host worker (host.ts), and reads the
// other providers' limits from BB itself.

import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, hostSignals } from "./host-contract";
import {
  hostInfoSchema,
  machineStateSchema,
  providerCardSchema,
  savedAccountSchema,
  usageSchema,
} from "./schema";
import type { MachineState, Usage } from "./schema";
import { listProviderCards, providerUsage } from "./lib/provider-usage";
import { resetLabel } from "./lib/reset-label";

export const rpcContract = defineRpcContract({
  state: { input: z.null(), output: machineStateSchema },
  host_info: { input: z.null(), output: hostInfoSchema },
  save: {
    input: z.object({ label: z.string().trim().min(1).max(60) }),
    output: z.object({ account: savedAccountSchema }),
  },
  rename: {
    input: z.object({ id: z.string(), label: z.string().trim().min(1).max(60) }),
    output: z.object({ account: savedAccountSchema }),
  },
  forget: {
    input: z.object({ id: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
  switch_to: {
    input: z.object({ id: z.string() }),
    output: z.object({
      account: savedAccountSchema,
      savedPrevious: z.boolean(),
    }),
  },
  usage: {
    input: z.object({ id: z.string() }),
    output: z.object({ usage: usageSchema }),
  },
  providers: {
    input: z.null(),
    output: z.object({ providers: z.array(providerCardSchema) }),
  },
  provider_usage: {
    input: z.object({ providerId: z.string() }),
    output: z.object({ usage: usageSchema }),
  },
  login_start: { input: z.null(), output: z.object({ url: z.string() }) },
  login_poll: {
    input: z.null(),
    output: z.object({
      status: z.enum(["idle", "pending", "done", "failed"]),
      url: z.string().nullable(),
      account: savedAccountSchema.nullable(),
      message: z.string().nullable(),
    }),
  },
  login_cancel: { input: z.null(), output: z.object({ cancelled: z.boolean() }) },
});

const ACCOUNTS_CHANGED = "accounts-changed";

function formatPercent(value: number): string {
  const filled = Math.round((value / 100) * 20);
  return `${`#`.repeat(filled).padEnd(20, ".")} ${String(value).padStart(3)}%`;
}

function formatResets(resetsAt: string | null): string {
  const label = resetLabel(resetsAt);
  return label === null ? "" : `  resets ${label}`;
}

function renderUsage(title: string, usage: Usage): string {
  switch (usage.status) {
    case "ok": {
      const head = [title, usage.planLabel, usage.accountEmail]
        .filter((part) => part !== null && part !== "")
        .join(" · ");
      if (usage.windows.length === 0) return `${head}\nNo limit windows reported.`;
      const rows = usage.windows.map(
        (window) =>
          `${window.label.padEnd(18)} ${formatPercent(window.usedPercent)}${formatResets(window.resetsAt)}`,
      );
      return [head, ...rows].join("\n");
    }
    case "expired":
      return `${title}: Anthropic rejected the stored token. Run \`claude /login\` as this account, then \`bb claude-accounts save --label ${title}\`.`;
    case "unauthenticated":
      return `${title}: not logged in.`;
    case "not_installed":
      return `${title}: provider is not installed on this host.`;
    default:
      return `${title}: ${usage.message}`;
  }
}

function renderState(state: MachineState): string {
  const lines: string[] = [];
  const active = state.active;
  lines.push(
    active === null
      ? "Active: no Claude Code login on this machine."
      : `Active: ${active.email ?? "unknown"}${active.displayName === null ? "" : ` (${active.displayName})`}${active.organizationName === null ? "" : ` · ${active.organizationName}`}`,
  );
  if (!state.cliInstalled) lines.push("`claude` is not on this host's PATH.");
  if (state.accounts.length === 0) {
    lines.push("No saved accounts. Run `bb claude-accounts save --label Work`.");
    return lines.join("\n");
  }
  lines.push("", "Saved accounts:");
  for (const account of state.accounts) {
    const mark = account.id === state.activeId ? "*" : " ";
    lines.push(
      `${mark} ${account.label.padEnd(24)} ${account.email ?? ""}${account.subscriptionType === null ? "" : ` · ${account.subscriptionType}`}`,
    );
  }
  return lines.join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  const unsubscribeChanged = host.experimental_onSignal("changed", () => {
    bb.realtime.publish(ACCOUNTS_CHANGED, {});
  });

  /** The machine BB itself runs on; every credential lives there. */
  const primaryHostId = async (): Promise<string | null> => {
    try {
      return (await bb.sdk.system.config()).primaryHostId;
    } catch {
      return null;
    }
  };

  const options = async (signal?: AbortSignal) => {
    const hostId = await primaryHostId();
    if (hostId === null) {
      throw new PluginCliError(
        "This BB server has no local host enrolled, so it cannot reach the Keychain.",
        { code: "no_host" },
      );
    }
    return { hostId, signal };
  };

  bb.rpc.register(rpcContract, {
    state: async () => host.call("state", null, await options()),
    host_info: async () => ({
      hostId: await primaryHostId(),
      platform: process.platform,
    }),
    save: async ({ label }) => host.call("save", { label }, await options()),
    rename: async (input) => host.call("rename", input, await options()),
    forget: async (input) => host.call("forget", input, await options()),
    switch_to: async ({ id }) => host.call("switchTo", { id }, await options()),
    usage: async ({ id }) => host.call("usage", { id }, await options()),
    providers: async () => ({
      providers: await listProviderCards(bb, await primaryHostId()),
    }),
    provider_usage: async ({ providerId }) => ({
      usage: await providerUsage(bb, providerId, await primaryHostId()),
    }),
    login_start: async () => host.call("loginStart", null, await options()),
    login_poll: async () => host.call("loginPoll", null, await options()),
    login_cancel: async () => host.call("loginCancel", null, await options()),
  });

  bb.cli.register(
    defineCli({
      name: "claude-accounts",
      summary: "Switch between saved Claude Code logins and read their limits",
      commands: {
        status: cliCommand({
          summary: "Active login and saved accounts",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input, ctx) {
            const state = await host.call("state", null, await options(ctx.signal));
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(state, null, 2)
                : renderState(state),
            };
          },
        }),
        list: cliCommand({
          summary: "Saved accounts",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input, ctx) {
            const state = await host.call("state", null, await options(ctx.signal));
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(state.accounts, null, 2)
                : state.accounts
                    .map(
                      (account) =>
                        `${account.id === state.activeId ? "*" : " "} ${account.label}  ${account.email ?? ""}`,
                    )
                    .join("\n") || "No saved accounts.",
            };
          },
        }),
        save: cliCommand({
          summary: "Save the machine's current Claude login under a label",
          options: {
            label: {
              type: "string",
              description: "Label for this account",
              required: true,
            },
          },
          async run(input, ctx) {
            const { account } = await host.call(
              "save",
              { label: input.options.label },
              await options(ctx.signal),
            );
            return {
              exitCode: 0,
              stdout: `Saved "${account.label}" (${account.email ?? account.id}).`,
            };
          },
        }),
        switch: cliCommand({
          summary: "Make a saved account the active Claude login",
          positionals: [
            { name: "account", description: "Label or email", required: true },
          ],
          async run(input, ctx) {
            const state = await host.call("state", null, await options(ctx.signal));
            const query = input.positionals.account.toLowerCase();
            const target = state.accounts.find(
              (account) =>
                account.label.toLowerCase() === query ||
                account.email?.toLowerCase() === query ||
                account.id === input.positionals.account,
            );
            if (target === undefined) {
              throw new PluginCliError(
                `No saved account matches "${input.positionals.account}".`,
                {
                  code: "unknown_account",
                  hint: "Run `bb claude-accounts list`.",
                },
              );
            }
            const result = await host.call(
              "switchTo",
              { id: target.id },
              await options(ctx.signal),
            );
            const note = result.savedPrevious
              ? " The previous login was saved first."
              : "";
            return {
              exitCode: 0,
              stdout: `Switched to "${result.account.label}".${note} Start a new Claude thread; running threads keep their session.`,
            };
          },
        }),
        forget: cliCommand({
          summary: "Remove a saved account and its stored credentials",
          positionals: [
            { name: "account", description: "Label or email", required: true },
          ],
          async run(input, ctx) {
            const state = await host.call("state", null, await options(ctx.signal));
            const query = input.positionals.account.toLowerCase();
            const target = state.accounts.find(
              (account) =>
                account.label.toLowerCase() === query ||
                account.email?.toLowerCase() === query ||
                account.id === input.positionals.account,
            );
            if (target === undefined) {
              throw new PluginCliError(
                `No saved account matches "${input.positionals.account}".`,
                { code: "unknown_account" },
              );
            }
            await host.call("forget", { id: target.id }, await options(ctx.signal));
            return { exitCode: 0, stdout: `Removed "${target.label}".` };
          },
        }),
        usage: cliCommand({
          summary: "Limits of a saved Claude account",
          positionals: [
            { name: "account", description: "Label or email", required: true },
          ],
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input, ctx) {
            const state = await host.call("state", null, await options(ctx.signal));
            const query = input.positionals.account.toLowerCase();
            const target = state.accounts.find(
              (account) =>
                account.label.toLowerCase() === query ||
                account.email?.toLowerCase() === query ||
                account.id === input.positionals.account,
            );
            if (target === undefined) {
              throw new PluginCliError(
                `No saved account matches "${input.positionals.account}".`,
                { code: "unknown_account" },
              );
            }
            const { usage } = await host.call(
              "usage",
              { id: target.id },
              await options(ctx.signal),
            );
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(usage, null, 2)
                : renderUsage(target.label, usage),
            };
          },
        }),
        providers: cliCommand({
          summary: "Other providers BB is logged into",
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input) {
            const providers = await listProviderCards(bb, await primaryHostId());
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(providers, null, 2)
                : providers
                    .map(
                      (provider) =>
                        `${provider.providerId.padEnd(16)} ${provider.accountEmail ?? ""}${provider.planLabel === null ? "" : ` · ${provider.planLabel}`}`,
                    )
                    .join("\n") || "No other providers are logged in.",
            };
          },
        }),
        "provider-usage": cliCommand({
          summary: "Limits of another provider (cursor, codex, …)",
          positionals: [
            { name: "provider", description: "Provider id", required: true },
          ],
          options: { json: { type: "boolean", description: "Emit JSON" } },
          async run(input) {
            const usage = await providerUsage(
              bb,
              input.positionals.provider,
              await primaryHostId(),
            );
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(usage, null, 2)
                : renderUsage(input.positionals.provider, usage),
            };
          },
        }),
        login: cliCommand({
          summary: "Sign in another Claude account in the browser",
          async run(_input, ctx) {
            const { url } = await host.call(
              "loginStart",
              null,
              await options(ctx.signal),
            );
            const lines = [
              "Opened the browser. Approve the login there.",
              url,
            ];
            const deadline = Date.now() + 5 * 60_000;
            for (;;) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
              const poll = await host.call(
                "loginPoll",
                null,
                await options(ctx.signal),
              );
              if (poll.status === "done" && poll.account !== null) {
                lines.push(
                  `Signed in as ${poll.account.email ?? poll.account.label} and saved it.`,
                );
                return { exitCode: 0, stdout: lines.join("\n") };
              }
              if (poll.status === "failed") {
                throw new PluginCliError(poll.message ?? "Sign-in failed.", {
                  code: "login_failed",
                });
              }
              if (poll.status === "idle" || Date.now() > deadline) {
                await host.call("loginCancel", null, await options(ctx.signal));
                throw new PluginCliError("Sign-in did not finish in time.", {
                  code: "login_timeout",
                });
              }
            }
          },
        }),
      },
    }),
  );

  return () => {
    unsubscribeChanged();
    bb.log.info("disposed");
  };
}
