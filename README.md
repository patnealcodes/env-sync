<p align="center">
    <img src="assets/env-sync-mark.svg" alt="env-sync" width="128">
</p>

# env-sync

Bring a local dotenv file up to date with its example **without replacing matching local values**. There is no daemon, hook, MCP server, network service or background scanning. Run it when you want to sync.

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

Run `env-sync` from the project directory. With no paths, it uses `.envsync.json` if present; otherwise it infers targets from templates in the current directory only. This works in this repo and in yours. For example, `.env.example` creates `.env` if missing; settings copied from the template take effect **next run**. Review the template before accepting settings such as disabling backups.

The CLI reads these optional keys from the **current working directory's** `.env` once per invocation. Explicit CLI flags and paths take precedence over exported environment variables, then local file settings, then built-in defaults. Other keys are never exported or evaluated. The example is only a template, not runtime configuration.

- `ENV_SYNC_JSON=true`: one value-free JSON result per target, in target order.
- `ENV_SYNC_NO_BACKUP=true`: skips backups and the backup prompt on subsequent runs until changed. It never approves key removals. Defaults to `false`; Git and file safety checks remain mandatory.
- `ENV_SYNC_HELP=true`: shows usage without syncing.
- `ENV_SYNC_BACKUP_DIR`: absolute private directory outside Git; blank uses the normal home-directory default.

### Project mappings: `.envsync.json`

Run `env-sync --scan` from the project root to create or update `.envsync.json`. This command only inspects filenames and edits the manifest; it never reads dotenv values or syncs destinations. Review the file, then run `env-sync` to apply its mappings. `env-sync <example> <target>` still selects exactly one pair without reading the manifest.

The manifest is strict JSON. All paths (including targets) are relative to its directory and use forward slashes:

```json
{
  "mappings": [
    { "source": ".env.example", "targets": [".env", ".env.test.local"] },
    { "source": "apps/client/env.sample", "targets": ["apps/client/.env"] }
  ]
}
```

JSON gives editors a known syntax and lets the CLI reject misspelled fields, unsafe paths and overlapping targets. The cost is more punctuation and no comments or trailing commas. The manifest contains paths only and can be committed. `ENV_SYNC_TARGET_FILES` is no longer read.

- Scan recognizes `.env.example`, `.env.sample`, `env.example` and their variants. Both `.env.sample` and `env.example` suggest a sibling `.env`; `.env.local.example` suggests `.env.local`. Ordinary local files such as `.env.production` never become sources based on an ignore rule.
- Recursive discovery skips symlinks, hidden directories, nested Git repos and dependency/build directories (`node_modules`, `vendor`, `dist`, `build`, `coverage`). Templates may be tracked or ignored. Git checks still apply to every destination **when syncing**.
- Rescan appends only new sources. Existing target lists and their order are preserved, even if a source disappeared. Use an empty `targets` array to explicitly skip a known source. No changes means no rewrite.
- If two examples suggest the same destination, nothing is written. Edit or create the manifest to assign different targets or skip one source, then scan again.
- Without a manifest, `env-sync` looks only in the working directory and does **not** create a manifest. An existing manifest is authoritative, including an empty one. Sync stops at the first target failure; earlier updates remain. `--scan --json` returns a single scan result and does not load CLI preferences from `.env`.

## What changes?

| Situation                                                     | Result                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Key in both files                                             | Keep the local value token verbatim, including empty values, quotes and embedded newlines.      |
| Key only in the example                                       | Copy its example value.                                                                         |
| Key only in the local file                                    | Ask before removing it. Declining leaves the entire target untouched, including its other keys. |
| Order, spacing, blank lines, comments, `export`, line endings | Use the example's layout. Local comments are not retained.                                      |
| Missing local file                                            | Create it from the example; no backup.                                                          |
| Byte-identical result                                         | Return `unchanged`; no writes, permission changes or backup rotation.                           |

The example is never modified. Review example changes before running, especially an empty example: it proposes removing every local key, which requires approval. Reports show key **names**, counts, status, review reasons and (on updates) the backup path. No diffs, comments, values or raw parser/subprocess diagnostics are printed. The logo and color are limited to interactive human-readable terminals; `--json` and redirected output remain unadorned. Set `NO_COLOR` to disable color without hiding the logo.

**Supported format:** UTF-8 (optional BOM), LF or CRLF, `#` comments, optional `export`, and case-sensitive keys matching `[A-Za-z_][A-Za-z0-9_]*`. Single-, double- and backtick-quoted values can span lines; a backslash inside quotes protects the next character from closing the quote. Outside quotes, `#` starts a comment, even without a preceding space. Nothing is unescaped, expanded or executed. Duplicate keys, unsupported assignments, unclosed quotes and unquoted trailing backslashes are refused rather than guessed at. Limit: 8 MiB per input and output. This is not a shell script parser.

## When an example changes

Use `env-sync --since HEAD .env.example .env` to compare the working example with its last committed version. After pulling an upgrade, use the **previous** release tag or commit instead of `HEAD`. This is a normal sync with extra review notices, **not a dry run**. Without `--since`, there are no historical notices: a difference between local and example values alone isn't evidence of a change.

| Change (illustrative values only)                                               | What happens                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blank gains a default: `REGION=` → `REGION=us`; local is `eu`                   | Keep `eu`; report **default added**. An explicitly empty local value stays empty too.                                                                         |
| Local still matches the old default: `TIMEOUT=30` → `60`; local is `30`         | Keep `30`; report **still matches the previous default**. Update it manually if desired.                                                                      |
| Local already matches the new default: `PORT=3000` → `8080`; local is `8080`    | Keep it; nothing to review.                                                                                                                                   |
| Local override, type or units change: `RETRY=3` → `auto`; local is `5`          | Keep `5`; report **check your local override**. Dotenv values are strings: no type conversion, unit inference or validation against the app.                  |
| URL path changes: example moves from `/v1` to `/v2`; local uses a proxy URL     | Flag the changed default; never append, strip or rewrite a path in the local URL.                                                                             |
| Default removed but key remains: `ZONE=west` → `ZONE=`                          | Keep the local value. A nonempty local value gets the previous-default or override notice; a blank one already matches. This is not key deletion.             |
| Comment or layout only: `# seconds` → `# milliseconds`, same value              | Copy the new comment/layout; no default-change notice. Even meaningful prose changes aren't interpreted.                                                      |
| New variable: example adds `LOG_LEVEL=info`                                     | If missing locally, copy `info` and report **added**. If a local `LOG_LEVEL=debug` predates the example key, keep it and flag the new example key for review. |
| Key disappears, was always local-only, or is renamed: `OLD_TOKEN` → `API_TOKEN` | Prompt before losing `OLD_TOKEN`. A rename is a deletion plus a new example key, not a secret migration. Decline and move the value yourself if needed.       |

Comparison ignores wrapping quotes and surrounding assignment formatting; it does not expand variables or interpret escape sequences. Successful `--json --since` results include `review` entries such as `{"key":"TIMEOUT","reason":"PREVIOUS_DEFAULT"}`, even when the file is `unchanged`. The tool stores no history of local values. If the revision or the example at that path isn't available, the requested comparison stops **before syncing**. Choose another ref or explicitly omit `--since`.

### Approving removals

Removal protection works **with or without `--since`**. The interactive CLI lists all affected names before writing. Only `y` approves the proposed removals for that target; Enter, Ctrl-C or EOF leaves that file and its backup untouched. This also protects against an accidentally empty example. Earlier targets in a batch are not rolled back.

In JSON or redirected mode the CLI never prompts. It returns `REMOVAL_CONFIRMATION_REQUIRED` and a `removed` array of **proposed**, not completed, removals. After reviewing the names, approve just those keys for a single target:

```sh
env-sync --json --remove-key OLD_TOKEN --remove-key OLD_URL .env.example .env
```

`--remove-key` doesn't remove a key still present in the example. There is no blanket approval or persistent removal setting. Agents should ask the user before retrying with these flags. The two-argument Node API also refuses removals. Approval to remove keys does **not** waive the backup requirement, and `--no-backup` does **not** approve removals.

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

To skip the backup and **backup prompt** for one run, use `env-sync --no-backup .env.example .env`. This does not create or rotate a backup, even if storage is available. Removed values may be unrecoverable. All destination safety checks still apply. With `--json --no-backup`, an update reports `"backup": null`; agents should only pass the flag when explicitly authorized.

If the backup cannot be saved, an interactive CLI lists the key names it would remove and recommends making a manual backup. Enter `y` to continue **once** without an automatic backup. Enter, Ctrl-C or EOF cancels without replacing the file. Git refusals cannot be overridden. If local contents change while you decide, the update is refused.

`--json`, redirected runs and the Node API never prompt or accept piped consent. If an attempted backup fails because storage is unavailable, they return `BACKUP_UNAVAILABLE` and leave the destination alone. Set a writable backup location and retry. A missing or unchanged destination still needs no backup.

## Development

`npm test` builds the CLI and runs parser and end-to-end tests against disposable files and real Git repositories. CI is configured for macOS and Windows, including permission checks on both.
