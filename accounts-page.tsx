// The Claude accounts page: switch the machine's Claude Code login and read
// limits. Tokens never reach this component — only labels, emails, and
// percentages come over RPC.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { resetLabel } from "./lib/reset-label";
import type { rpcContract } from "./server";
import type {
  CodexAccount,
  CodexState,
  MachineState,
  ProviderCard,
  SavedAccount,
  Usage,
} from "./schema";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

function UsageView({ usage, provider = "claude" }: { usage: Usage; provider?: "claude" | "codex" }) {
  if (usage.status === "ok") {
    if (usage.windows.length === 0) {
      return (
        <p className="mt-3 text-xs text-muted-foreground">
          No limit windows reported.
        </p>
      );
    }
    return (
      <div className="mt-3 space-y-2">
        {usage.windows.map((window) => {
          const reset = resetLabel(window.resetsAt);
          return (
            <div key={window.label}>
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">{window.label}</span>
                <span className="tabular-nums">
                  {window.usedPercent}%{reset === null ? "" : ` · resets ${reset}`}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full",
                    window.usedPercent >= 90 ? "bg-destructive" : "bg-primary",
                  )}
                  style={{ width: `${Math.max(2, window.usedPercent)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  const message =
    usage.status === "expired"
      ? provider === "codex"
        ? "Codex access token expired. Switch to this account and start a new Codex thread to refresh it."
        : "Anthropic rejected the stored token. Run `claude /login` as this account, then press Save current."
      : usage.status === "unauthenticated"
        ? "Not logged in."
        : usage.status === "not_installed"
          ? "This provider is not installed on the host."
          : usage.message;
  return <p className="mt-3 text-xs text-muted-foreground">{message}</p>;
}

/** Loads a card's limits on demand; the card decides where to draw them. */
function useUsage(load: () => Promise<Usage>) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [pending, setPending] = useState(false);
  const check = () => {
    setPending(true);
    load()
      .then(setUsage, (cause: unknown) =>
        setUsage({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      )
      .finally(() => setPending(false));
  };
  return { usage, pending, check };
}

function LimitsButton({
  pending,
  onClick,
}: {
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={onClick}>
      <Icon name="Gauge" className="size-4" />
      {pending ? "Checking…" : "Limits"}
    </Button>
  );
}

function AccountCard({
  account,
  isActive,
  rpc,
  onChanged,
  onError,
}: {
  account: SavedAccount;
  isActive: boolean;
  rpc: Rpc;
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const [pending, setPending] = useState(false);
  const limits = useUsage(
    async () => (await rpc.call("usage", { id: account.id })).usage,
  );
  return (
    <li className="rounded-lg border border-border bg-card p-4">
      {/* Controls stay on one row whatever the limits below them do. */}
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{account.label}</span>
            {isActive ? (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                Active
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {[account.email, account.organizationName, account.subscriptionType]
              .filter((part) => part !== null && part !== "")
              .join(" · ")}
          </p>
        </div>
        <LimitsButton pending={limits.pending} onClick={limits.check} />
        <Button
          size="sm"
          disabled={isActive || pending}
          onClick={() => {
            setPending(true);
            rpc
              .call("switch_to", { id: account.id })
              .then(onChanged, onError)
              .finally(() => setPending(false));
          }}
        >
          {isActive ? "In use" : pending ? "Switching…" : "Switch"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Forget "${account.label}"`}
          disabled={pending}
          onClick={() => {
            setPending(true);
            rpc
              .call("forget", { id: account.id })
              .then(onChanged, onError)
              .finally(() => setPending(false));
          }}
        >
          <Icon name="Trash2" className="size-4" />
        </Button>
      </div>
      {limits.usage === null ? null : <UsageView usage={limits.usage} />}
    </li>
  );
}

function CodexAccountCard({ account, isActive, rpc, pending, setPending, onChanged, onError }: {
  account: CodexAccount;
  isActive: boolean;
  rpc: Rpc;
  pending: boolean;
  setPending: (value: boolean) => void;
  onChanged: () => void;
  onError: (cause: unknown) => void;
}) {
  const limits = useUsage(async () => (await rpc.call("codex_usage", { id: account.id })).usage);
  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{account.label}</span>
            {isActive ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">Active</span> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">{account.email ?? account.id}</p>
        </div>
        <LimitsButton pending={limits.pending} onClick={limits.check} />
        <Button size="sm" disabled={pending || isActive} onClick={() => {
          setPending(true);
          rpc.call("codex_switch", { id: account.id }).then(onChanged, onError).finally(() => setPending(false));
        }}>{isActive ? "In use" : pending ? "Switching…" : "Switch"}</Button>
        <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Forget Codex account "${account.label}"`} disabled={pending || isActive} onClick={() => {
            setPending(true);
            rpc.call("codex_forget", { id: account.id }).then(onChanged, onError).finally(() => setPending(false));
          }}><Icon name="Trash2" className="size-4" /></Button>
      </div>
      {limits.usage === null ? null : <UsageView usage={limits.usage} provider="codex" />}
    </li>
  );
}

function ProviderRow({ provider, rpc }: { provider: ProviderCard; rpc: Rpc }) {
  const limits = useUsage(
    async () =>
      (await rpc.call("provider_usage", { providerId: provider.providerId }))
        .usage,
  );
  return (
    <li className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <span className="font-medium">{provider.displayName}</span>
          <p className="truncate text-xs text-muted-foreground">
            {[provider.accountEmail, provider.planLabel]
              .filter((part) => part !== null && part !== "")
              .join(" · ") || provider.providerId}
          </p>
        </div>
        <LimitsButton pending={limits.pending} onClick={limits.check} />
      </div>
      {limits.usage === null ? null : <UsageView usage={limits.usage} />}
    </li>
  );
}

/** Drives the browser sign-in: start, then poll until the tab comes back. */
function useLogin(rpc: Rpc, onDone: () => void) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const start = () => {
    setMessage(null);
    setPending(true);
    rpc.call("login_start").then(
      () => {
        setMessage("Approve the login in the browser tab that just opened.");
        stopPolling();
        timer.current = setInterval(() => {
          rpc.call("login_poll").then(
            (poll) => {
              if (poll.status === "pending") return;
              stopPolling();
              setPending(false);
              if (poll.status === "done" && poll.account !== null) {
                setMessage(`Signed in as ${poll.account.email ?? poll.account.label}.`);
                onDone();
              } else if (poll.status === "failed") {
                setMessage(poll.message ?? "Sign-in failed.");
              } else {
                setMessage("Sign-in was cancelled.");
              }
            },
            (cause: unknown) => {
              stopPolling();
              setPending(false);
              setMessage(cause instanceof Error ? cause.message : String(cause));
            },
          );
        }, 2000);
      },
      (cause: unknown) => {
        setPending(false);
        setMessage(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const cancel = () => {
    stopPolling();
    setPending(false);
    setMessage(null);
    rpc.call("login_cancel").catch(() => undefined);
  };

  return { pending, message, start, cancel };
}

function useCodexLogin(rpc: Rpc, onDone: () => void) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const start = () => {
    setPending(true);
    setMessage(null);
    rpc.call("codex_login_start").then(() => {
      setMessage("Approve the Codex sign-in in the browser tab that just opened.");
      stopPolling();
      timer.current = setInterval(() => {
        rpc.call("codex_login_poll").then((poll) => {
          if (poll.status === "pending") {
            setMessage(poll.message);
            return;
          }
          stopPolling();
          setPending(false);
          if (poll.status === "done" && poll.account !== null) {
            setMessage(`Signed in as ${poll.account.email ?? poll.account.id}. Add a label and press Save current.`);
            onDone();
          } else {
            setMessage(poll.status === "failed" ? poll.message ?? "Sign-in failed." : "Sign-in was cancelled.");
          }
        }, (cause: unknown) => {
          stopPolling();
          setPending(false);
          setMessage(cause instanceof Error ? cause.message : String(cause));
        });
      }, 2000);
    }, (cause: unknown) => {
      setPending(false);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const cancel = () => {
    rpc.call("codex_login_cancel").then(({ cancelled }) => {
      if (!cancelled) {
        setMessage("Saving the new Codex login…");
        return;
      }
      stopPolling();
      setPending(false);
      setMessage("Sign-in was cancelled.");
    }, (cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)));
  };
  return { pending, message, start, cancel };
}

export function AccountsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<MachineState | null>(null);
  const [providers, setProviders] = useState<ProviderCard[]>([]);
  const [codex, setCodex] = useState<CodexState | null>(null);
  const [codexLabel, setCodexLabel] = useState("");
  const [codexPending, setCodexPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  const onError = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("state").then((next) => {
      setState(next);
      setError(null);
    }, onError);
    rpc.call("providers").then((next) => setProviders(next.providers), onError);
    rpc.call("codex_state").then(setCodex, onError);
  }, [rpc, onError]);

  useEffect(refetch, [refetch]);
  useRealtime("accounts-changed", refetch);
  const login = useLogin(rpc, refetch);
  const codexLogin = useCodexLogin(rpc, refetch);

  const active = state?.active ?? null;
  const codexCurrentSaved = codex !== null && codex.activeError === null &&
    (codex.activeId === null || codex.accounts.some((account) => account.id === codex.activeId));

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <section className="rounded-lg border border-border bg-card p-4">
          <h2 className="text-sm font-medium">This machine</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {state === null
              ? "Reading the current Claude Code login…"
              : active === null
                ? "No Claude Code login found. Run `claude /login` first."
                : `${active.email ?? "unknown"}${active.displayName === null ? "" : ` · ${active.displayName}`}${active.organizationName === null ? "" : ` · ${active.organizationName}`}`}
          </p>
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const next = label.trim();
              if (next === "" || saving) return;
              setSaving(true);
              rpc
                .call("save", { label: next })
                .then(() => {
                  setLabel("");
                  refetch();
                }, onError)
                .finally(() => setSaving(false));
            }}
          >
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="Label for the current login (Work, Personal, …)"
              aria-label="Label for the current login"
            />
            <Button type="submit" disabled={saving || label.trim() === ""}>
              <Icon name="Save" className="size-4" />
              Save current
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={login.start}
              disabled={login.pending}
            >
              <Icon name="LogIn" className="size-4" />
              {login.pending ? "Waiting for the browser…" : "Sign in another account"}
            </Button>
            {login.pending ? (
              <Button variant="ghost" size="sm" onClick={login.cancel}>
                Cancel
              </Button>
            ) : null}
            {login.message === null ? null : (
              <span className="text-xs text-muted-foreground">
                {login.message}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Signing in saves the new account here and makes it the machine's
            login. Switching takes effect in new Claude threads; running
            threads keep their session.
          </p>
        </section>

        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <h2 className="mt-6 text-sm font-medium">Saved accounts</h2>
        {state === null ? (
          <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
        ) : state.accounts.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            None yet. Save the current login above.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {state.accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                isActive={account.id === state.activeId}
                rpc={rpc}
                onChanged={refetch}
                onError={onError}
              />
            ))}
          </ul>
        )}

        <h2 className="mt-6 text-sm font-medium">Codex accounts</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {codex === null ? "Reading the current Codex login…" :
            `Current login: ${codex.activeError ?? codex.activeEmail ?? codex.activeId ?? "none"}.${codex.activeId !== null && !codexCurrentSaved ? " Add a label and save it before switching accounts." : ""}`}
        </p>
        <form className="mt-3 flex items-center gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!codexLabel.trim() || codexPending || codexLogin.pending) return;
          setCodexPending(true);
          rpc.call("codex_save", { label: codexLabel.trim() }).then(() => {
            setCodexLabel(""); refetch();
          }, onError).finally(() => setCodexPending(false));
        }}>
          <Input value={codexLabel} onChange={(event) => setCodexLabel(event.target.value)}
            placeholder="Label for the current login (Work, Personal, …)" aria-label="Codex account label" />
          <Button type="submit" disabled={codexPending || codexLogin.pending || !codexLabel.trim()}>
            <Icon name="Save" className="size-4" /> Save current
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={codexLogin.start} disabled={codexPending || codexLogin.pending || !codexCurrentSaved}>
            <Icon name="LogIn" className="size-4" />
            {codexLogin.pending ? "Waiting for the browser…" : "Sign in another account"}
          </Button>
          {codexLogin.pending ? <Button variant="ghost" size="sm" onClick={codexLogin.cancel}>Cancel</Button> : null}
          {codexLogin.message === null ? null : <span className="text-xs text-muted-foreground">{codexLogin.message}</span>}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Signing in activates the new account. Save it with a label to add it to the list. Finish running Codex threads before switching accounts.
        </p>
        {codex?.accounts.length ? (
          <ul className="mt-2 space-y-2">
            {codex.accounts.map((account) => (
              <CodexAccountCard key={account.id} account={account} isActive={account.id === codex.activeId}
                rpc={rpc} pending={codexPending || codexLogin.pending || !codexCurrentSaved} setPending={setCodexPending}
                onChanged={refetch} onError={onError} />
            ))}
          </ul>
        ) : <p className="mt-2 text-sm text-muted-foreground">No saved Codex accounts yet.</p>}

        <h2 className="mt-6 text-sm font-medium">Other providers</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Limits only.
        </p>
        {providers.filter((provider) => provider.providerId !== "codex").length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No other provider is logged in on this host.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {providers.filter((provider) => provider.providerId !== "codex").map((provider) => (
              <ProviderRow
                key={provider.providerId}
                provider={provider}
                rpc={rpc}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
