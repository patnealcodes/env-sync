import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { saveBackup } from "./backup.js";
import { basename, dirname, join, resolve, sep } from "node:path";
import { merge, type Keys, type Baseline, type Review } from "./dotenv.js";
import { gitGuard } from "./git.js";
import { privateWrite, protect } from "./private-files.js";

type Code =
  | "USAGE"
  | "GIT_SAFETY"
  | "INVALID_ENV"
  | "UNSAFE_PATH"
  | "BASELINE_UNAVAILABLE"
  | "BUSY"
  | "BACKUP_UNAVAILABLE"
  | "CHANGED"
  | "IO";
type Failure = {
  readonly ok: false;
  readonly code: Code;
  readonly message: string;
};
/** Value-free result for manual tools. Only an update produces a backup. */
export type SyncResult =
  | Failure
  | {
      readonly ok: false;
      readonly code: "REMOVAL_CONFIRMATION_REQUIRED";
      readonly message: string;
      readonly removed: readonly string[];
    }
  | ({
      readonly ok: true;
      readonly keys: Keys;
      readonly review?: readonly Review[];
    } & (
      | { readonly status: "created" | "unchanged" }
      | { readonly status: "updated"; readonly backup: string | null }
    ));
function fail(code: Code, message: string): Failure {
  return { ok: false, code, message };
}

function isExists(e: unknown) {
  return e instanceof Error && "code" in e && e.code === "EEXIST";
}
function canonical(path: string) {
  return join(
    realpathSync.native(dirname(resolve(path))),
    basename(resolve(path)),
  );
}
function unsafeName(path: string) {
  return (
    path
      .split(sep)
      .some((p) =>
        /^(?:\.git|\.gitignore|\.gitattributes|\.gitmodules|\.env-sync-backups|\.env-sync-lock-.*)$/i.test(
          p,
        ),
      ) ||
    (process.platform === "win32" &&
      (!/^[a-z]:\\/i.test(path) || /[:]|[ .](?:\\|$)/.test(path.slice(2))))
  );
}

/** Read an optional regular, unlinked UTF-8 input using the sync safety checks. */
export function snapshot(path: string) {
  const info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!info) return { ok: true, text: undefined } as const;
  if (!info.isFile() || info.nlink !== 1n)
    return fail(
      "UNSAFE_PATH",
      "Use regular, non-linked files. Directories, symlinks and hard links are refused.",
    );
  if (info.size > 8n * 1024n * 1024n)
    return fail("INVALID_ENV", "Input exceeds the 8 MiB limit.");
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
      return fail("CHANGED", "Input changed while opening. Retry the sync.");
    const bytes = readFileSync(fd);
    try {
      return {
        ok: true,
        text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes,
        ),
      } as const;
    } catch {
      return fail(
        "INVALID_ENV",
        "Input is not valid UTF-8. Convert it before syncing.",
      );
    }
  } finally {
    closeSync(fd);
  }
}

/** Separate consent decisions. Neither approval implies the other. */
export type Prompt = {
  readonly kind: "removal" | "backup";
  readonly removed: readonly string[];
};

/** Holds one validated plan and its lock across a possible consent prompt. */
export function* syncWorkflow(
  exampleFile: string,
  localFile: string,
  backupPolicy: "save" | "skip" = "save",
  backupDir = process.env.ENV_SYNC_BACKUP_DIR || undefined,
  baseline?: Baseline,
): Generator<Prompt, SyncResult, boolean> {
  let operation =
    "resolve the input paths. Check that both parent directories exist";
  try {
    if (
      typeof exampleFile !== "string" ||
      !exampleFile ||
      typeof localFile !== "string" ||
      !localFile
    )
      return fail("USAGE", "Provide an example path and a local path.");
    const example = canonical(exampleFile);
    let target = canonical(localFile);
    if (unsafeName(target))
      return fail(
        "UNSAFE_PATH",
        "Choose a local dotenv file outside reserved Git and env-sync paths.",
      );
    operation = "read the inputs. Check file access permissions";
    const refusal = gitGuard(target, "untracked-ignored");
    if (refusal) return fail("GIT_SAFETY", refusal);
    const local = snapshot(target);
    if (!local.ok) return local;
    if (local.text !== undefined) target = realpathSync.native(target);
    const source = snapshot(example);
    if (!source.ok) return source;
    if (source.text === undefined)
      return fail(
        "IO",
        "Example file does not exist. Check the first argument.",
      );
    if (local.text !== undefined) {
      const a = lstatSync(example, { bigint: true }),
        b = lstatSync(target, { bigint: true });
      if (a.dev === b.dev && a.ino === b.ino)
        return fail(
          "UNSAFE_PATH",
          "Example and destination must be different files.",
        );
    }
    const plan = merge(source.text, local.text ?? "", baseline);
    if (!plan.ok) return plan;
    if (Buffer.byteLength(plan.text) > 8 * 1024 * 1024)
      return fail("INVALID_ENV", "Merged output exceeds the 8 MiB limit.");
    const summary = {
      keys: plan.keys,
      ...(plan.review ? { review: plan.review } : {}),
    };
    if (plan.text === local.text)
      return { ok: true, status: "unchanged", ...summary };
    if (
      plan.keys.removed.length &&
      (yield { kind: "removal", removed: plan.keys.removed }) !== true
    ) {
      return {
        ok: false,
        code: "REMOVAL_CONFIRMATION_REQUIRED",
        removed: plan.keys.removed,
        message:
          "Local-only keys would be removed. This file was not changed. Run interactively or authorize each removal with --remove-key NAME.",
      };
    }

    const id = createHash("sha256").update(target).digest("hex");
    const stage = join(dirname(target), `.env-sync-lock-${id}`);
    const next = join(stage, "next");
    operation =
      "create private staging storage. Check directory permissions and filesystem ACL support";
    try {
      mkdirSync(stage, { mode: 0o700 });
    } catch (e) {
      if (isExists(e))
        return fail(
          "BUSY",
          "A sync lock exists. Wait for the other sync, or see README for interrupted-run recovery.",
        );
      throw e;
    }
    try {
      protect(stage, "new");
      writeFileSync(join(stage, ".gitignore"), "*\n", {
        flag: "wx",
        mode: 0o600,
      });
      const stagingRefusal = gitGuard(next, "untracked-ignored");
      if (stagingRefusal)
        return fail(
          "GIT_SAFETY",
          "Cannot confirm Git protection for temporary storage. Nothing was replaced.",
        );
      privateWrite(next, plan.text);
      const verify = (): Failure | undefined => {
        const blocked = gitGuard(target, "untracked-ignored");
        if (blocked) return fail("GIT_SAFETY", blocked);
        if (plan.keys.removed.length) {
          const template = snapshot(example);
          if (!template.ok) return template;
          if (template.text !== source.text)
            return fail(
              "CHANGED",
              "Example changed after removals were planned. This file was not replaced; retry with the current example.",
            );
        }
        const current = snapshot(target);
        if (!current.ok) return current;
        if (current.text !== local.text)
          return fail(
            "CHANGED",
            "Destination changed during sync. Nothing was replaced; retry with the current file.",
          );
        return undefined;
      };
      const changed = verify();
      if (changed) return changed;
      if (local.text === undefined) {
        operation =
          "create the destination without overwriting an existing file. Check for concurrent edits and hard-link support";
        linkSync(next, target);
        return { ok: true, status: "created", ...summary };
      }

      let backup: string | null = null;
      if (backupPolicy !== "skip") {
        const saved = saveBackup(id, local.text, example, target, backupDir);
        if (saved.ok) backup = saved.backup;
        else {
          if (saved.code !== "BACKUP_UNAVAILABLE") return saved;
          const approved = yield { kind: "backup", removed: plan.keys.removed };
          if (approved !== true) return saved;
        }
      }
      const conflict = verify();
      if (conflict) return conflict;
      operation =
        "replace the destination. Close programs locking the file and retry";
      renameSync(next, target);
      return {
        ok: true,
        status: "updated",
        ...summary,
        backup,
      };
    } finally {
      try {
        rmSync(stage, { recursive: true, force: true });
      } catch (e) {
        operation =
          "remove private staging storage. Check the destination and any sync lock before retrying";
        throw e;
      }
    }
  } catch {
    return fail("IO", `Could not ${operation}.`);
  }
}
