# Claude Accounts

A [BB](https://getbb.app) plugin for several Claude Code logins on one machine,
switchable from BB, plus limits for Claude, Cursor and Codex.

## Install

```
bb plugin install git:https://github.com/fzrx-ego/bb-plugin-claude-accounts.git@semver:^0.3.0
```

## Page

Sidebar → **Claude accounts**.

- **This machine** — the login Claude Code is using now, and a field to save
  it under a label.
- **Saved accounts** — Switch, Limits (percent bars per window), Forget.
- **Other providers** — Cursor, Codex and any other provider BB is logged
  into. Limits only; their logins are never touched.

A switch applies to **new** Claude threads. Threads already running keep the
session they started with.

## CLI

```
bb claude-accounts status
bb claude-accounts list [--json]
bb claude-accounts save --label Work
bb claude-accounts switch Work
bb claude-accounts usage Work [--json]
bb claude-accounts providers
bb claude-accounts provider-usage cursor
bb claude-accounts forget Work
bb claude-accounts login          # the three steps for adding an account
```

## Where the secrets are

- Claude's own credentials: login Keychain, service `Claude Code-credentials`.
- Snapshots: login Keychain, service `bb-claude-accounts`, one item per
  account uuid, holding the credentials plus the `oauthAccount` block of
  `~/.claude.json`.
- Labels and identities: `<dataDir>/plugins/claude-accounts/host-data/accounts.json`.

Only `host.ts` touches any of that, and it runs in the host worker. The
server, the page, and the CLI see labels, emails, plans and percentages —
never a token.

## Switching

A switch first proves the target snapshot can still sign in: if its access
token aged out, it is refreshed, and only a successful refresh lets the
switch proceed. A snapshot Anthropic no longer accepts fails loudly and
leaves the machine's login alone. The outgoing login is always re-snapshotted
first, because Claude rotates tokens while an account is active.

## Limits

`usage` reads the active account's live credentials, and for other accounts
the snapshot's own token, so a check never disturbs the current login. An
access token that expired while the account sat idle is refreshed against
Claude Code's OAuth client and the rotated pair is written back into the
snapshot immediately.

## Adding a second account

**Sign in another account** on the page (or `bb claude-accounts login`) runs
Claude Code's own OAuth flow: it opens claude.com in the browser, catches the
redirect on a loopback port, and writes the result into the Keychain, into
`~/.claude.json`, and into a snapshot under the new account's email. The
login it produces is the one Claude Code itself would have produced —
same client id, same scopes.

## Develop

```
bb plugin dev .
bb plugin build .
bb plugin install .
```

macOS only: everything hangs off `security(1)` and the login Keychain.

Source lives in `~/.bb/user-plugins/` on purpose: a plugin installed from a
thread workspace disappears when that environment is retired.
