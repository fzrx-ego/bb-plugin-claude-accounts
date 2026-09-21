Several Claude Code logins on one machine: save them, switch between them, and read limits. Cursor and Codex show limits only.

## Who it is for

People who keep more than one Claude account on the same computer and hit session limits mid-thread.

Not a password manager. Tokens stay in this Mac's Keychain. The plugin never sends them to a server.

## What you get

- A **Claude accounts** page: this machine's login, saved accounts, Switch, Limits, Forget
- **Sign in another account** opens Claude's own browser OAuth and saves the result
- Limits for the active Claude login and for saved snapshots
- Limits for Cursor, Codex and other providers BB is already logged into — read-only
- CLI: `bb claude-accounts`

A switch applies to new Claude threads. Running threads keep the session they started with. A snapshot Anthropic no longer accepts is refused, and the machine's current login is left alone.

## How it works

Claude Code credentials live in the login Keychain. The plugin stores a snapshot per account in a second Keychain service and the labels in plugin host-data. Only the host worker touches those files.

## First step

Open **Claude accounts**, confirm the machine's current login, press Limits on a saved account.
