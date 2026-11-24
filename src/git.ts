import { parse } from "./dotenv.js";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

function gitIn(dir: string) {
  // An alternate repository or index could disagree with discovery at the target.
  if (
    Object.keys(process.env).some((k) =>
      /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS)$/i.test(
        k,
      ),
    )
  ) {
    return undefined;
  }
  // Honor configured global/system ignores; don't inherit tracing or pathspec overrides.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !/^GIT_/i.test(k) || /^GIT_CONFIG_(GLOBAL|SYSTEM|NOSYSTEM)$/i.test(k),
    ),
  );
  const executable = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((p) => isAbsolute(p))
    .map((p) => join(p, process.platform === "win32" ? "git.exe" : "git"))
    .find((p) => existsSync(p));
  if (!executable) return undefined;
  return (...args: string[]) =>
    spawnSync(executable, ["-c", "core.fsmonitor=false", "-C", dir, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      timeout: 10000,
      env: {
        ...env,
        LC_ALL: "C",
        GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
      },
    });
}

/** Resolve the revision once. Read a literal blob at the example's path, never a diff or filter. */
export function loadBaseline(example: string, ref: string) {
  const unavailable = {
    ok: false,
    code: "BASELINE_UNAVAILABLE",
    message:
      "Cannot read the historical example. Choose a local Git ref containing this example at the same path, or omit --since. No files were synced.",
  } as const;
  try {
    const path = resolve(example);
    const git = gitIn(dirname(path));
    if (!git) return unavailable;
    const tree = git(
      "rev-parse",
      "--verify",
      "--end-of-options",
      ref + "^{tree}",
    );
    const oid = tree.stdout?.toString().trim();
    if (
      tree.status !== 0 ||
      !oid ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)
    )
      return unavailable;
    const blob = git("cat-file", "blob", oid + ":./" + basename(path));
    if (blob.status !== 0 || blob.error) return unavailable;
    return parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        blob.stdout,
      ),
      "Historical example",
    );
  } catch {
    return unavailable;
  }
}

/** A refusal message is static and never includes Git diagnostics or paths. */
export function gitGuard(
  path: string,
  policy: "untracked-ignored" | "outside",
): string | undefined {
  const dir = dirname(path);
  const git = gitIn(dir);
  const unknown =
    "Cannot verify Git protection. Use a normal shell with Git installed and an accessible repository and index.";
  if (!git) return unknown;
  const probe = git("rev-parse", "--is-inside-work-tree");
  if (
    probe.status === 128 &&
    /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(
      probe.stderr.toString(),
    )
  ) {
    // Git can report "not a repository" for a damaged/unreadable .git.
    for (let p = dir; ; p = dirname(p)) {
      if (
        lstatSync(join(p, ".git"), { throwIfNoEntry: false }) ||
        basename(p).toLowerCase() === ".git"
      )
        return unknown;
      if (dirname(p) === p) return undefined;
    }
  }
  if (probe.status !== 0 || probe.stdout.toString().trim() !== "true")
    return unknown;
  if (policy === "outside")
    return "The backup location is inside a Git repository. Set ENV_SYNC_BACKUP_DIR to a dedicated private directory outside Git.";
  const file = "./" + basename(path);
  const tracked = git("--literal-pathspecs", "ls-files", "-z", "--", file);
  if (tracked.status !== 0) return unknown;
  if (tracked.stdout.length)
    return "Destination is tracked. Choose an untracked, ignored local file. If secrets were committed, rotate them.";
  const ignored = git("check-ignore", "-q", "--", file);
  if (ignored.status === 0) return undefined;
  if (ignored.status === 1)
    return "Destination is not ignored. Add a matching .gitignore or .git/info/exclude rule, then retry.";
  return unknown;
}
