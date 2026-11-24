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

## Project settings

Run `env-sync` from the project directory. With no settings or paths, it syncs `.env.example` to `.env`. This works in this repo and in yours. On the first run with no local file, it creates just `.env`; settings copied from the template take effect **next run**. Review the template before accepting settings such as disabling backups.

The CLI reads these optional keys from the **current working directory's** `.env` once per invocation. Explicit CLI flags and paths take precedence over exported environment variables, then local file settings, then built-in defaults. Other keys are never exported or evaluated. The example is only a template, not runtime configuration.

- `ENV_SYNC_TARGET_FILES`: comma-separated local dotenv filenames, default `.env`. With no paths, the CLI syncs each in order against `.env.example` and stops on the first failure. Earlier updates remain in place. Two explicit paths always select only that pair.
- `ENV_SYNC_JSON=true`: one value-free JSON result per target, in target order.
- `ENV_SYNC_NO_BACKUP=true`: skips backups and confirmation on subsequent runs until changed. Defaults to `false`; Git and file safety checks remain mandatory.
- `ENV_SYNC_HELP=true`: shows usage without syncing.
- `ENV_SYNC_BACKUP_DIR`: absolute private directory outside Git; blank uses the normal home-directory default.

For example, with `ENV_SYNC_TARGET_FILES=.env.local,.env.test.local` in your local `.env`, run `env-sync` for both, or `env-sync .env.example .env.local` for just one. If `.env` itself is a target, include any settings you want preserved in its template, just like other keys.

## What changes?

| Situation                                                     | Result                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Key in both files                                             | Keep the local value token verbatim, including empty values, quotes and embedded newlines.         |
| Key only in the example                                       | Copy its example value.                                                                            |
| Key only in the local file                                    | Remove it from the local file; recovery requires a backup. A rename is a removal plus an addition. |
| Order, spacing, blank lines, comments, `export`, line endings | Use the example's layout. Local comments are not retained.                                         |
| Missing local file                                            | Create it from the example; no backup.                                                             |
| Byte-identical result                                         | Return `unchanged`; no writes, permission changes or backup rotation.                              |

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

Statuses: `created`, `updated` (also returns `backup`), `unchanged`. Failures have `ok: false`, a stable `code` such as `GIT_SAFETY`, and a value-free `message`. Exit codes: `0` success, `1` refusal/I/O failure, `2` usage error. A Node tool wrapper can instead import `syncEnv(examplePath, localPath)` from `env-example-sync` when installed locally; it returns the same object synchronously. The Node API takes an explicit pair and does not load CLI preferences from the working directory.

## Git protection, backups and recovery

- **Inside a worktree both conditions are mandatory:** the destination must be absent from the Git index **and** covered by an ignore rule, even when it doesn't exist yet. On refusal the terminal prints a prominent warning. Add an appropriate ignore rule yourself; the tool never edits Git configuration, untracks files or offers a force flag. Ignoring a previously committed secret does not remove it from history; rotate exposed credentials.
- Outside Git, syncing is allowed. Git must still be available so that an unverified repository isn't mistaken for a non-repository. The backup location must be outside Git.
- By default, each update backs up the exact previous file in `~/.env-sync-backups/<hash-of-local-path>.bak` (`~` is your Windows profile or Unix home). One backup per destination, rotated only before replacement. Restore by copying the reported backup over the same **ignored local file**, keeping access owner-only. Don't use the backup as the template. Backups are **plaintext**, not encrypted; protect your account, disk and system backups accordingly.
- New files use mode `0600` and private directories `0700` on macOS. On Windows the tool sets and checks a protected current-user-only access control list. Destination and staging protection are mandatory even if you confirm a sync without a backup. Untouched files keep their existing permissions.
- Writes use private staging on the destination volume. In Git, staging is checked for ignore protection before secret bytes are written. Updates flush the new bytes before a same-volume rename; creation uses a no-overwrite hard link. Input symlinks, hard-linked inputs and non-regular files are refused. These guarantees are for trusted local directories on a filesystem with native permissions and rename semantics, not network shares or hostile processes running as your user.
- A per-destination lock blocks competing syncs and the tool rechecks the local contents before replacement. Other editors do not honor this lock: don't edit the file, index or ignore rules during a run. After interruption, confirm no sync is running, check the local file and latest backup, then remove the stale `.env-sync-lock-<hash>` directory beside the target. It may contain secret bytes; do not publish it. Incomplete `.tmp` files in the private backup directory can likewise be removed after checking no sync is running.

### When home directory writes are restricted

Set `ENV_SYNC_BACKUP_DIR` to the **absolute path of a dedicated private directory outside Git**. The parent must already exist; let env-sync create the backup directory and set its permissions. No home-directory fallback is attempted.

```sh
# macOS (example path; use an approved writable location)
export ENV_SYNC_BACKUP_DIR="/Volumes/WorkPrivate/env-sync-backups"
```

```powershell
# Windows PowerShell
$env:ENV_SYNC_BACKUP_DIR = 'D:\WorkPrivate\env-sync-backups'
```

To skip the backup and confirmation for **one run**, use `env-sync --no-backup .env.example .env`. This does not create or rotate a backup, even if storage is available. Removed values may be unrecoverable. All destination safety checks still apply. With `--json --no-backup`, an update reports `"backup": null`; agents should only pass the flag when explicitly authorized.

If the backup cannot be saved, an interactive CLI lists the key names it would remove and recommends making a manual backup. Enter `y` to continue **once** without an automatic backup. Enter, Ctrl-C or EOF cancels without replacing the file. Git refusals cannot be overridden. If local contents change while you decide, the update is refused.

`--json`, redirected runs and the Node API never prompt or accept piped consent. If an attempted backup fails because storage is unavailable, they return `BACKUP_UNAVAILABLE` and leave the destination alone. Set a writable backup location and retry. A missing or unchanged destination still needs no backup.

## Development

`npm test` builds the CLI and runs parser and end-to-end tests against disposable files and real Git repositories. CI is configured for macOS and Windows, including permission checks on both.
