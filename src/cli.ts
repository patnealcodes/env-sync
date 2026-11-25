#!/usr/bin/env node
import { loadBaseline } from "./git.js";
import type { Baseline } from "./dotenv.js";
import { scanManifest, syncPlan } from "./manifest.js";
import { loadSettings } from "./settings.js";
import { createInterface } from "node:readline";
import { syncWorkflow, type SyncResult, type Prompt } from "./workflow.js";

const usage =
  "Usage: env-sync [--scan] [--json] [--no-backup] [--since <ref>] [--remove-key NAME] [<example-file> <local-file>]";
const helpText =
  usage +
  "\n--scan recursively adds template paths to the JSON .envsync.json file; it does not sync targets. With no paths, use .envsync.json or discover templates in the current directory only. Settings come from .env in the working directory.\n--json emits one value-free result per target. --no-backup skips backup creation, not removal consent.\n--since compares example defaults with a Git revision. Repeat --remove-key NAME to authorize specific removals for one target.";
const args: string[] = [];
let json = false,
  skipBackup = false,
  scan = false,
  help = false,
  invalidOption = false,
  endOptions = false;
let since: string | undefined;
const permitted = new Set<string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === undefined) continue;
  if (!endOptions && arg === "--") endOptions = true;
  else if (!endOptions && arg === "--scan") scan = true;
  else if (!endOptions && arg === "--json") json = true;
  else if (!endOptions && arg === "--no-backup") skipBackup = true;
  else if (!endOptions && (arg === "--since" || arg === "--remove-key")) {
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) invalidOption = true;
    else {
      i++;
      if (arg === "--since" && since === undefined) since = value;
      else if (arg === "--remove-key" && /^[A-Za-z_][A-Za-z_0-9]*$/.test(value))
        permitted.add(value);
      else invalidOption = true;
    }
  } else if (!endOptions && arg === "--help") help = true;
  else if (!endOptions && arg.startsWith("-")) invalidOption = true;
  else args.push(arg);
}

async function confirm({ kind, removed }: Prompt) {
  const deleting = kind === "removal";
  console.error(
    paint(
      deleting
        ? "!! WARNING: LOCAL KEYS WOULD BE REMOVED !!"
        : "!! WARNING: NO AUTOMATIC BACKUP !!",
      "1;97;41",
      process.stderr,
    ),
  );
  console.error(
    deleting
      ? "These keys are absent from the example. Decline to keep this file untouched."
      : "Your local file has not been replaced. Back it up to an approved private location before continuing.",
  );
  console.error(
    `Keys to remove (${removed.length}): ${removed.join(", ") || "none"}`,
  );
  const reader = createInterface({
    input: process.stdin,
    output: process.stderr,
    historySize: 0,
  });
  try {
    return await new Promise<boolean>((resolve) => {
      reader.once("SIGINT", () => resolve(false));
      reader.once("close", () => resolve(false));
      reader.once("error", () => resolve(false));
      reader.question(
        deleting
          ? "Remove these keys and continue? [y/N] "
          : "Continue without an automatic backup? [y/N] ",
        (answer) => resolve(answer.trim().toLowerCase() === "y"),
      );
    });
  } finally {
    reader.close();
  }
}

async function run(
  example: string,
  local: string,
  backupDir: string | undefined,
  baseline: Baseline | undefined,
): Promise<SyncResult> {
  const interactive =
    !json &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    process.stderr.isTTY;
  const work = syncWorkflow(
    example,
    local,
    skipBackup ? "skip" : "save",
    backupDir,
    baseline,
  );
  let step = work.next();
  while (!step.done) {
    let approved = false;
    try {
      if (
        step.value.kind === "removal" &&
        step.value.removed.every((key) => permitted.has(key))
      )
        approved = true;
      else if (interactive) approved = await confirm(step.value);
    } catch {
      /* An unreadable or disconnected terminal never grants consent. */
    }
    step = work.next(approved);
  }
  return step.value;
}

function paint(
  text: string,
  color: string,
  stream: NodeJS.WriteStream = process.stdout,
) {
  return stream.isTTY && process.env.NO_COLOR === undefined
    ? `\x1b[${color}m${text}\x1b[0m`
    : text;
}

function report(result: SyncResult) {
  if (json) console.log(JSON.stringify(result));
  else if (!result.ok) {
    const title =
      result.code === "GIT_SAFETY"
        ? "!! GIT SAFETY WARNING — SYNC REFUSED !!"
        : "!! SYNC FAILED !!";
    console.error(
      paint(title, "1;97;41", process.stderr) + "\n" + result.message,
    );
    if (result.code === "REMOVAL_CONFIRMATION_REQUIRED")
      console.error("Keys to remove: " + result.removed.join(", "));
  } else {
    const statusColor = { created: "1;32", updated: "1;33", unchanged: "2" };
    console.log(
      `  Status: ${paint(result.status, statusColor[result.status])}`,
    );
    for (const [group, label, color] of [
      ["added", "+ Added", "32"],
      ["removed", "− Removed", "31"],
      ["preserved", "= Preserved", "34"],
    ] as const) {
      const keys = result.keys[group];
      if (!keys.length) continue;
      console.log("  " + paint(`${label} (${keys.length})`, color));
      let line = "";
      for (const key of keys) {
        if (
          line &&
          4 + line.length + 2 + key.length > (process.stdout.columns || 80)
        ) {
          console.log("    " + line);
          line = "";
        }
        line += (line ? ", " : "") + key;
      }
      console.log("    " + line);
    }
    if (result.review?.length) {
      const descriptions = {
        DEFAULT_ADDED: "example now provides a default; local value kept",
        PREVIOUS_DEFAULT: "still matches the previous default",
        OVERRIDE: "example default changed; check your local override",
        KEY_ADDED: "new example key; existing local value kept",
      };
      console.log("  " + paint(`! Review (${result.review.length})`, "1;33"));
      for (const item of result.review)
        console.log(`    ${item.key} — ${descriptions[item.reason]}`);
    }
    if (result.status === "updated")
      console.log(
        "  Backup: " +
          (result.backup === null
            ? "none (you approved this update without one)"
            : JSON.stringify(result.backup)),
      );
  }
  return result.ok ? 0 : result.code === "USAGE" ? 2 : 1;
}

function showHelp() {
  console.log(
    json
      ? JSON.stringify({ ok: true, status: "help", message: helpText })
      : helpText,
  );
  return 0;
}

async function main() {
  if (help) return showHelp();
  if (scan) {
    if (
      invalidOption ||
      args.length ||
      skipBackup ||
      since !== undefined ||
      permitted.size
    )
      return report({
        ok: false,
        code: "USAGE",
        message: "Use env-sync --scan [--json] without sync flags or paths.",
      });
    const result = scanManifest();
    if (!result.ok) return report(result);
    if (json) console.log(JSON.stringify(result));
    else
      console.log(
        `.envsync.json: ${result.status} (${result.added} new sources). No dotenv files synced.`,
      );
    return 0;
  }
  const config = loadSettings();
  if (!config.ok) {
    json ||=
      ("json" in config && config.json === true) ||
      process.env.ENV_SYNC_JSON === "true";
    return report({ ok: false, code: config.code, message: config.message });
  }
  json ||= config.json;
  skipBackup ||= config.skipBackup;
  if (config.help) return showHelp();
  const [example, local] = args;
  if (
    invalidOption ||
    (args.length !== 0 && (args.length !== 2 || !example || !local))
  )
    return report({ ok: false, code: "USAGE", message: usage });
  const plan =
    example && local
      ? ({ ok: true, pairs: [{ example, target: local }] } as const)
      : syncPlan();
  if (!plan.ok) return report(plan);
  const targets = plan.pairs;
  if (permitted.size && targets.length !== 1)
    return report({
      ok: false,
      code: "USAGE",
      message: "Use --remove-key with a single target to scope your approval.",
    });
  const baselines = new Map<string, Baseline>();
  if (since !== undefined) {
    for (const pair of targets) {
      if (baselines.has(pair.example)) continue;
      const baseline = loadBaseline(pair.example, since);
      if (!baseline.ok) return report(baseline);
      baselines.set(pair.example, baseline.tokens);
    }
  }
  if (!json)
    console.log(
      `${paint("env-sync", "1;36")} · ${targets.length} ${targets.length === 1 ? "file" : "files"}`,
    );
  for (const [index, { example: template, target }] of targets.entries()) {
    if (!json) {
      // Explicit paths may contain terminal controls. Never render them verbatim.
      const pathLabel = target.replace(
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
      );
      console.log(
        `\n${paint(`[${index + 1}/${targets.length}]`, "2")} ${paint(pathLabel, "1;35")}`,
      );
    }
    const status = report(
      await run(template, target, config.backupDir, baselines.get(template)),
    );
    if (status !== 0) return status;
  }
  return 0;
}

process.exitCode = await main();
