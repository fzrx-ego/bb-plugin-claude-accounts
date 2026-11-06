# Fast Switch Accounts

A [BB](https://getbb.app) plugin for switching saved Claude Code and Codex
logins on one machine, plus provider limits.

## Install

```
bb plugin install git:https://github.com/fzrx-ego/bb-plugin-claude-accounts.git@semver:^0.4.0
```

From a local checkout:

```
bb plugin build .
bb plugin install .
```

## Page

Sidebar → **Fast Switch Accounts**.

- **This machine** — the login Claude Code is using now, and a field to save
  it under a label.
- **Saved accounts** — Switch, Limits (percent bars per window), Forget.
- **Codex accounts** — save the current ChatGPT login with a label, switch,
  check each saved account's limits, forget, or sign in to another account in
  the browser.
- **Other providers** — limits for Cursor and other BB providers.

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
bb claude-accounts codex-status
bb claude-accounts codex-save --label Work
bb claude-accounts codex-login
bb claude-accounts codex-switch Work
bb claude-accounts codex-usage Work
bb claude-accounts codex-forget Work
```

## Where the secrets are

### macOS

- Claude's own credentials: login Keychain, service `Claude Code-credentials`.
- Snapshots: login Keychain, service `bb-claude-accounts`, one item per
  account uuid, holding the credentials plus the `oauthAccount` block of
  `~/.claude.json`.
- Codex snapshots: login Keychain, service `bb-codex-accounts` (written via a
  small Swift helper so tokens stay out of `argv`).

### Windows

- Claude's own credentials: `~/.claude/.credentials.json` (same path Claude
  Code already uses on Windows).
- Claude / Codex snapshots: DPAPI-protected files under
  `%LOCALAPPDATA%\bb-claude-accounts\secrets\`, keyed by service + account id.
  Secrets are encrypted for the current Windows user.

### Shared

- Labels and identities: `<dataDir>/plugins/claude-accounts/host-data/accounts.json`
  (and `codex-accounts.json` for Codex labels).
- Active Codex login: `~/.codex/auth.json`. BB's isolated `CODEX_HOME` links
  its `auth.json` to this file.

Only `host.ts` touches any of that, and it runs in the host worker. The
server, the page, and the CLI see labels, emails, plans and percentages —
never a token.

## Codex switching

Press **Sign in another account** in the Codex section (or run
`bb claude-accounts codex-login`). The plugin runs the installed Codex CLI's
browser sign-in in a separate temporary home. Save the current login with a
label before starting. After approval the plugin refreshes the outgoing saved
snapshot and activates the new login. Enter a label and press **Save current**
to add the new login to the list. A switch atomically
replaces `~/.codex/auth.json` with the chosen snapshot. It affects
new Codex threads. Finish running Codex threads before switching accounts:
an old thread can refresh credentials and write to the shared auth file.
API-key logins are not supported. On macOS, saving a Codex login needs the
Xcode Command Line Tools. On Windows, snapshots use DPAPI instead. If an idle
snapshot's refresh token has been revoked, run `codex login` for that account
and save it again.
Forgetting the active account removes its saved snapshot while leaving the live
Codex login in place. Save it with a label before switching away.

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
redirect on a loopback port, and writes the result into the platform
credential store, into `~/.claude.json`, and into a snapshot under the new
account's email. The login it produces is the one Claude Code itself would
have produced — same client id, same scopes.

## Develop

```
bb plugin dev .
bb plugin build .
bb plugin install .
```

Supported on **macOS** (Keychain + `security(1)`) and **Windows** (Claude
credentials file + DPAPI snapshot store).

Source lives in `~/.bb/user-plugins/` on purpose: a plugin installed from a
thread workspace disappears when that environment is retired.
