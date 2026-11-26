# Git sync

Sync moves the vault's `.omarkie` journals between computers through a git repository the user already made. Omarkie never creates a repository or a remote.

## What one sync does

1. Flush pending journal lines.
2. Commit the vault's local changes, deletions included. Machine-local files (`.omarkie/writer.lock`, `.omarkie/journal.lock`) are neither committed nor pulled: they name one process, so syncing one would make the other computer read-only.
3. Fetch the checked-out branch.
4. Fast-forward when the remote is ahead.
5. Merge `.omarkie/**/*.jsonl` as a line union; the reader's `opId`, HLC and tombstone rules decide the result. `.omarkie/settings.json` merges by field, so two computers that opened the vault before their first pull keep one vault id; stamps (`createdAt`) name the vault's origin. Other non-journal changes on both sides report a conflict and are not applied.
6. Push the merge commit, retry once after a fetch if the push was refused.

One job runs per vault. It refuses when another window holds the writer lock, when the vault root is not the repository root, or when git ignores `.omarkie`.

A repository with no commits yet is fetched shallow (`depth: 1`). The remote must be HTTP(S) with no user name or password in the URL.

## Remote and branch

The remote is stored in `.omarkie/settings.json` as `sync.remote` and `sync.branch`. When absent, the repository's `origin` remote and current branch are used. Only HTTP(S) remotes work; an SSH origin is rejected with a clear message. The last sync result is local app data, not a vault file, so two computers do not conflict on status.

## Token

- Paste the token into **Sync**. It is sent only to that remote's HTTP authentication.
- On a secure keychain (`safeStorage` with libsecret/Keychain/DPAPI) it is encrypted into Omarkie app data; the plaintext never touches `.omarkie/`, settings, logs or a journal.
- When Linux reports `basic_text` or the keychain is unavailable, Omarkie refuses persistence. The token can be used for this session only and is gone when the app quits.
- A saved token is never shown back. **Forget token** removes the ciphertext and the session copy.

## Folder-sync apps

A vault inside Google Drive, OneDrive, Dropbox, Nextcloud, Syncthing or iCloud Drive is labelled **Synced by <app>** in Sync settings. Omarkie only detects the folder name or metadata marker; it does not manage or pause those apps.

## Agent parity

```sh
omarkie-axi sync status      # repository, branch, keychain state, last result
omarkie-axi sync now         # one sync; no token access
```

Both commands need the vault open in Omarkie because the running app owns the writer lock. Results never contain the token.
