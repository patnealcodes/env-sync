# env-sync

Bring a local dotenv file up to date with its example **without replacing matching local values**. There is no daemon, hook, MCP server, network service or automatic discovery. Run it when you want to sync.

## Install and run

From this checkout, with Node.js 22.12+ and Git on `PATH`:

```sh
npm ci
npm link
```

Then, from your project:

```sh
env-sync .env.example .env
env-sync --json .env.staging.example .env.staging.local
```

`npm link` is optional: use `node /path/to/env-example-sync/dist/cli.js ...` instead. On Windows the tool requires Windows PowerShell 5.1 (included with Windows) and a local NTFS drive; if PowerShell blocks npm's script shim, use `npm.cmd` / `env-sync.cmd`. Both input paths can be absolute or relative to the caller. The local file's parent directory must exist.

## What changes?

| Situation                                                     | Result                                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Key in both files                                             | Keep the local value token verbatim, including empty values, quotes and embedded newlines.                |
| Key only in the example                                       | Copy its example value.                                                                                   |
| Key only in the local file                                    | Remove it from the local file; it remains in the pre-sync backup. A rename is a removal plus an addition. |
| Order, spacing, blank lines, comments, `export`, line endings | Use the example's layout. Local comments are not retained.                                                |
| Missing local file                                            | Create it from the example; no backup.                                                                    |
| Byte-identical result                                         | Return `unchanged`; no writes, permission changes or backup rotation.                                     |

The example is never modified. Review example changes before running, especially an empty example: it intentionally removes all local keys. Only key **names**, counts, status, and (on updates) the backup path are reported. No diffs, comments, values or raw parser/subprocess diagnostics are printed. Color is limited to interactive terminals; set `NO_COLOR` to disable it.

**Supported format:** UTF-8 (optional BOM), LF or CRLF, `#` comments, optional `export`, and case-sensitive keys matching `[A-Za-z_][A-Za-z0-9_]*`. Single-, double- and backtick-quoted values can span lines; a backslash inside quotes protects the next character from closing the quote. Outside quotes, `#` starts a comment, even without a preceding space. Nothing is unescaped, expanded or executed. Duplicate keys, unsupported assignments, unclosed quotes and unquoted trailing backslashes are refused rather than guessed at. Limit: 8 MiB per input and output. This is not a shell script parser.

## Manual agent tool

Call the CLI with an argument array (not an interpolated shell command), e.g. `['--json', examplePath, localPath]`. Read one JSON object from stdout, **including on failure**. Do not read the dotenv files or backup into the agent context.

```json
{
  "ok": true,
  "status": "created",
  "keys": { "added": ["API_URL"], "preserved": [], "removed": [] }
}
```

Statuses: `created`, `updated` (also returns `backup`), `unchanged`. Failures have `ok: false`, a stable `code` such as `GIT_SAFETY`, and a value-free `message`. Exit codes: `0` success, `1` refusal/I/O failure, `2` usage error. A Node tool wrapper can instead import `syncEnv(examplePath, localPath)` from `env-example-sync` when installed locally; it returns the same object synchronously. Register that wrapper only if desired.

## Git protection, backups and recovery

- **Inside a worktree both conditions are mandatory:** the destination must be absent from the Git index **and** covered by an ignore rule, even when it doesn't exist yet. On refusal the terminal prints a prominent warning. Add an appropriate ignore rule yourself; the tool never edits Git configuration, untracks files or offers a force flag. Ignoring a previously committed secret does not remove it from history; rotate exposed credentials.
- Outside Git, syncing is allowed. Git must still be available so that an unverified repository isn't mistaken for a non-repository. The backup location must be outside Git.
- Each update saves the exact previous file in `~/.env-sync-backups/<hash-of-local-path>.bak` (`~` is your Windows profile or Unix home). One backup per destination, rotated only before replacement. Restore by copying the reported backup over the same **ignored local file**, keeping access owner-only. Don't use the backup as the template. Backups are **plaintext**, not encrypted; protect your account, disk and system backups accordingly.
- New files use mode `0600` and private directories `0700` on macOS. On Windows the tool sets and checks a protected current-user-only access control list. If protection or backup creation fails, it won't replace the local file. Untouched files keep their existing permissions.
- Writes use private staging on the destination volume. In Git, staging is checked for ignore protection before secret bytes are written. Updates flush the new bytes before a same-volume rename; creation uses a no-overwrite hard link. Input symlinks, hard-linked inputs and non-regular files are refused. These guarantees are for trusted local directories on a filesystem with native permissions and rename semantics, not network shares or hostile processes running as your user.
- A per-destination lock blocks competing syncs and the tool rechecks the local contents before replacement. Other editors do not honor this lock: don't edit the file, index or ignore rules during a run. After interruption, confirm no sync is running, check the local file and latest backup, then remove the stale `.env-sync-lock-<hash>` directory beside the target. It may contain secret bytes; do not publish it. Incomplete `.tmp` files in the private backup directory can likewise be removed after checking no sync is running.

## Development

`npm test` builds the CLI and runs parser and end-to-end tests against disposable files and real Git repositories. CI is configured for macOS and Windows, including permission checks on both.
