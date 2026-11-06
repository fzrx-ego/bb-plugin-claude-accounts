---
name: claude-accounts
description: Switch the machine's Claude Code or Codex login between saved accounts and read provider limits with `bb claude-accounts`. Use when the user asks to change an account, check remaining limits, or list logins.
---

# Fast Switch Accounts

One Claude Code login is active per machine. This plugin snapshots logins in
the macOS Keychain (or a DPAPI store on Windows) and swaps them. Tokens stay
on the host.

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
bb claude-accounts codex-status           # active Codex login + saved accounts
bb claude-accounts codex-save --label Work
bb claude-accounts codex-login            # browser sign-in; save current first
bb claude-accounts codex-switch Work
bb claude-accounts codex-usage Work
bb claude-accounts codex-forget Work
```

Rules:

- A switch affects **new** Claude threads. Threads already running keep the
  session they started with.
- Codex switching changes `~/.codex/auth.json` for new threads. Finish running
  Codex threads before switching; an old thread may refresh the shared file.
- Add a Codex login from the page or with `bb claude-accounts codex-login`.
  Save the current login with a label first. The existing login stays active
  until browser sign-in succeeds. Label and save the new current login to add
  it to the list. Only ChatGPT logins are supported. Codex snapshots are stored
  in the macOS login Keychain, or DPAPI-protected files on Windows.
- `usage` reads the snapshot's own token, so it never disturbs the active
  login. An expired snapshot needs one `switch` to that account to refresh.
- `login` opens the browser, completes Claude's OAuth flow on a loopback
  port, makes that account active and saves it. No terminal login needed.
- A switch to a snapshot Anthropic no longer accepts fails and leaves the
  current login untouched; that account needs `bb claude-accounts login`.
