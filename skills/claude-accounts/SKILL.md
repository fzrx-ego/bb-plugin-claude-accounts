---
name: claude-accounts
description: Switch the machine's Claude Code login between saved accounts and read Claude/Cursor/Codex limits with `bb claude-accounts`. Use when the user asks to change Claude account, check remaining limits, or list logins.
---

# Claude accounts

One Claude Code login is active per machine. This plugin snapshots logins in
the macOS Keychain and swaps them. Tokens stay on the host.

```
bb claude-accounts status                 # active login + saved accounts
bb claude-accounts list [--json]
bb claude-accounts save --label Work      # snapshot the current login
bb claude-accounts switch Work            # make a saved account active
bb claude-accounts usage Work [--json]    # that account's limits
bb claude-accounts providers              # other providers BB is logged into
bb claude-accounts provider-usage cursor  # their limits
bb claude-accounts forget Work            # drop a snapshot
bb claude-accounts login                  # browser sign-in for a new account
```

Rules:

- A switch affects **new** Claude threads. Threads already running keep the
  session they started with.
- `usage` reads the snapshot's own token, so it never disturbs the active
  login. An expired snapshot needs one `switch` to that account to refresh.
- `login` opens the browser, completes Claude's OAuth flow on a loopback
  port, makes that account active and saves it. No terminal login needed.
- A switch to a snapshot Anthropic no longer accepts fails and leaves the
  current login untouched; that account needs `bb claude-accounts login`.
