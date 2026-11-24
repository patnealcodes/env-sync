#!/usr/bin/env node
import { loadSettings } from "./settings.js";
import { createInterface } from "node:readline";
import { syncWorkflow, type SyncResult } from "./workflow.js";

const usage =
  "Usage: env-sync [--json] [--no-backup] [<example-file> <local-file>]";
const helpText =
  usage +
  "\nWith no paths, sync .env.example to ENV_SYNC_TARGET_FILES (default: .env). Settings come from .env in the working directory.\n--json emits one value-free result per target. --no-backup skips the backup and confirmation.";
const args: string[] = [];
let json = false,
  skipBackup = false,
  help = false,
  invalidOption = false,
  endOptions = false;
for (const arg of process.argv.slice(2)) {
  if (!endOptions && arg === "--") endOptions = true;
  else if (!endOptions && arg === "--json") json = true;
  else if (!endOptions && arg === "--no-backup") skipBackup = true;
  else if (!endOptions && arg === "--help") help = true;
  else if (!endOptions && arg.startsWith("-")) invalidOption = true;
  else args.push(arg);
}

async function confirm(removed: readonly string[]) {
  console.error(
    paint("!! WARNING: NO AUTOMATIC BACKUP !!", "1;97;41", process.stderr),
  );
  console.error(
    "Your local file has not been replaced. Back it up to an approved private location before continuing.",
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
        "Continue without an automatic backup? [y/N] ",
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
  );
  let step = work.next();
  while (!step.done) {
    let approved = false;
    try {
      if (interactive) approved = await confirm(step.value);
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
  const targets = local ? [local] : config.targets;
  if (!json)
    console.log(
      `${paint("env-sync", "1;36")} · ${targets.length} ${targets.length === 1 ? "file" : "files"}`,
    );
  for (const [index, target] of targets.entries()) {
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
      await run(example ?? ".env.example", target, config.backupDir),
    );
    if (status !== 0) return status;
  }
  return 0;
}

process.exitCode = await main();
