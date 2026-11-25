import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { posix } from "node:path";
import { snapshot } from "./workflow.js";

const file = ".envsync.json";
const template = /^\.?env((?:\.[a-z0-9_-]+)*)\.(?:example|sample)$/i;
const skipped = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
]);
type Mapping = { readonly source: string; readonly targets: readonly string[] };
const invalid = (message: string) =>
  ({ ok: false, code: "INVALID_MANIFEST", message }) as const;
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function safePath(path: unknown, role: "source" | "target"): path is string {
  if (typeof path !== "string") return false;
  const parts = path.split("/"),
    name = parts.pop();
  if (
    !name ||
    (role === "source"
      ? !template.test(name)
      : !/^\.env(?:\.[a-z0-9_-]+)*$/i.test(name) || template.test(name))
  )
    return false;
  return parts.every(
    (p) =>
      /^[a-z0-9_@-][a-z0-9_@. -]*$/i.test(p) &&
      !/[ .]$/.test(p) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
  );
}

// Validate the complete graph before any target or manifest is written.
function validate(value: unknown) {
  if (
    !record(value) ||
    Object.keys(value).length !== 1 ||
    !Array.isArray(value.mappings)
  )
    return invalid(
      "Expected a JSON object with a mappings array in .envsync.json. See the README example.",
    );
  const mappings: Mapping[] = [],
    sources = new Set<string>(),
    owners = new Map<string, string>();
  for (const [i, row] of value.mappings.entries()) {
    if (
      !record(row) ||
      Object.keys(row).length !== 2 ||
      !safePath(row.source, "source") ||
      !Array.isArray(row.targets)
    )
      return invalid(
        `Mapping ${i + 1}: provide a project-relative template source and a targets array; no extra fields.`,
      );
    if (sources.has(row.source.toLowerCase()))
      return invalid(
        `Mapping ${i + 1}: duplicate source. Group its targets under one source.`,
      );
    sources.add(row.source.toLowerCase());
    const targets: string[] = [];
    for (const t of row.targets) {
      if (!safePath(t, "target"))
        return invalid(
          `Mapping ${i + 1}: use project-relative .env target paths with forward slashes; no templates, absolute paths or traversal.`,
        );
      const other = owners.get(t.toLowerCase());
      if (other)
        return invalid(
          `Target ${t} is assigned twice (${other}, ${row.source}). Edit .envsync.json to choose one owner or give each source a different target. Nothing was written.`,
        );
      owners.set(t.toLowerCase(), row.source);
      targets.push(t);
    }
    mappings.push({ source: row.source, targets });
  }
  return { ok: true, mappings } as const;
}

function discover(recursive: boolean) {
  const found: string[] = [];
  function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = posix.join(dir, e.name);
      if (e.isFile() && template.test(e.name)) found.push(path);
      else if (
        recursive &&
        e.isDirectory() &&
        !e.name.startsWith(".") &&
        !skipped.has(e.name.toLowerCase()) &&
        !existsSync(posix.join(path, ".git"))
      )
        walk(path);
    }
  }
  walk(".");
  return found
    .sort()
    .map((source) => ({
      source,
      targets: [
        posix.join(
          posix.dirname(source),
          posix.basename(source).replace(template, ".env$1"),
        ),
      ],
    }));
}

function readManifest() {
  const initial = snapshot(file);
  if (!initial.ok) return initial;
  if (initial.text === undefined)
    return { ok: true, mappings: [], original: undefined } as const;
  let value: unknown;
  try {
    value = JSON.parse(initial.text);
  } catch {
    return invalid(
      "Invalid JSON in .envsync.json. Check quotes, commas and brackets; comments and trailing commas are not supported. Nothing was written.",
    );
  }
  const result = validate(value);
  return result.ok ? { ...result, original: initial.text } : result;
}

/** Resolve the normal sync plan; without a manifest only inspect the current directory. */
export function syncPlan() {
  try {
    const manifest = readManifest();
    if (!manifest.ok) return manifest;
    const plan =
      manifest.original === undefined
        ? validate({ mappings: discover(false) })
        : manifest;
    if (!plan.ok) return plan;
    const pairs = plan.mappings.flatMap((m) =>
      m.targets.map((target) => ({ example: m.source, target })),
    );
    for (const { example, target } of pairs)
      for (const path of [example, target]) {
        let parent = ".";
        for (const part of path.split("/").slice(0, -1)) {
          parent = posix.join(parent, part);
          if (!lstatSync(parent, { throwIfNoEntry: false })?.isDirectory())
            return {
              ok: false,
              code: "UNSAFE_PATH",
              message:
                "Each mapped directory must exist and must not be a symlink or junction. Check .envsync.json.",
            } as const;
        }
      }
    return { ok: true, pairs } as const;
  } catch {
    return {
      ok: false,
      code: "IO",
      message:
        "Cannot inspect project mappings. Check .envsync.json and directory permissions.",
    } as const;
  }
}

/** Add newly discovered template paths only. Never read dotenv values or sync a target. */
export function scanManifest() {
  try {
    const manifest = readManifest();
    if (!manifest.ok) return manifest;
    const known = new Set(manifest.mappings.map((m) => m.source));
    const added = discover(true).filter((m) => !known.has(m.source));
    const next = validate({ mappings: [...manifest.mappings, ...added] });
    if (!next.ok) return next;
    if (manifest.original !== undefined && !added.length)
      return { ok: true, status: "unchanged", added: 0 } as const;
    const content = JSON.stringify({ mappings: next.mappings }, null, 2) + "\n";
    if (Buffer.byteLength(content) > 8 * 1024 * 1024)
      return invalid(
        "Discovered mappings exceed the 8 MiB limit. Run from a smaller project directory.",
      );
    const lock = ".envsync.json.lock";
    const fd = openSync(lock, "wx", 0o600);
    let ownsLock = true;
    try {
      try {
        writeFileSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const current = snapshot(file);
      if (!current.ok) return current;
      if (current.text !== manifest.original)
        return {
          ok: false,
          code: "CHANGED",
          message:
            ".envsync.json changed during discovery. Review the file and retry.",
        } as const;
      if (current.text === undefined) linkSync(lock, file);
      else {
        renameSync(lock, file);
        ownsLock = false;
      }
    } finally {
      if (ownsLock) rmSync(lock, { force: true });
    }
    return {
      ok: true,
      status: manifest.original === undefined ? "created" : "updated",
      added: added.length,
    } as const;
  } catch {
    return {
      ok: false,
      code: "IO",
      message:
        "Could not scan or save .envsync.json. Check project permissions and whether another scan holds .envsync.json.lock. No dotenv targets were synced.",
    } as const;
  }
}
