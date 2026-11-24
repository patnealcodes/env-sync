import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { gitGuard } from "./git.js";
import { privateWrite, protect } from "./private-files.js";

const unavailable = {
  ok: false,
  code: "BACKUP_UNAVAILABLE",
  message:
    "No automatic backup was created. Your local file was not replaced. Set ENV_SYNC_BACKUP_DIR to a dedicated, writable private directory outside Git, or run interactively.",
} as const;

/** Save the pre-sync bytes. Only an unavailable backup is eligible for confirmation. */
export function saveBackup(
  id: string,
  contents: string,
  example: string,
  target: string,
) {
  try {
    const configured =
      process.env.ENV_SYNC_BACKUP_DIR ?? join(homedir(), ".env-sync-backups");
    if (
      !isAbsolute(configured) ||
      dirname(resolve(configured)) === resolve(configured)
    )
      return unavailable;
    const store = join(
      realpathSync.native(dirname(resolve(configured))),
      basename(resolve(configured)),
    );
    if (store.split(sep).some((part) => /^\.env-sync-lock-/i.test(part)))
      return unavailable;
    const blocked = (message: string) =>
      ({ ok: false, code: "GIT_SAFETY", message }) as const;
    const unsafeStore = gitGuard(store, "outside");
    if (unsafeStore) return blocked(unsafeStore);
    let state: "existing" | "new" = "new";
    try {
      mkdirSync(store, { mode: 0o700 });
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST"))
        return unavailable;
      state = "existing";
    }
    if (!lstatSync(store).isDirectory()) return unavailable;
    const backup = join(store, id + ".bak");
    const unsafeBackup = gitGuard(backup, "outside");
    if (unsafeBackup) return blocked(unsafeBackup);
    // Never change ACLs on a general-purpose folder or rotate a backup over an input.
    if (state === "existing" && process.env.ENV_SYNC_BACKUP_DIR !== undefined) {
      if (
        readdirSync(store).some(
          (name) => !/^(?:[a-f0-9]{64}\.bak|[a-f0-9-]{36}\.tmp)$/.test(name),
        )
      )
        return unavailable;
      const previous = lstatSync(backup, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        previous &&
        [example, target].some((p) => {
          const f = lstatSync(p, { bigint: true });
          return f.dev === previous.dev && f.ino === previous.ino;
        })
      )
        return unavailable;
    }
    protect(store, state);
    const temp = join(store, randomUUID() + ".tmp");
    try {
      privateWrite(temp, contents);
      renameSync(temp, backup);
    } catch {
      try {
        rmSync(temp, { force: true });
      } catch {
        return {
          ok: false,
          code: "IO",
          message:
            "Could not clean up temporary backup storage. Check the private backup directory before retrying; the local file was not replaced.",
        } as const;
      }
      return unavailable;
    }
    return { ok: true, backup } as const;
  } catch {
    return unavailable;
  }
}
