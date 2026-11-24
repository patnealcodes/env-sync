#!/usr/bin/env node
import { createInterface } from "node:readline";
import { syncEnv, type SyncResult } from "./sync.js";
import { syncWorkflow } from "./workflow.js";

const usage = "Usage: env-sync [--json] <example-file> <local-file>";
const args = process.argv.slice(2);
const json = args[0] === "--json";
if (json) args.shift();

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

async function run(): Promise<SyncResult> {
  const [example, local] = args;
  if (args.length !== 2 || !example || !local)
    return { ok: false, code: "USAGE", message: usage };
  if (
    json ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    !process.stderr.isTTY
  )
    return syncEnv(example, local);
  const work = syncWorkflow(example, local);
  let step = work.next();
  while (!step.done) {
    let approved = false;
    try {
      approved = await confirm(step.value);
    } catch {
      /* An unreadable or disconnected terminal never grants consent. */
    }
    step = work.next(approved);
  }
  return step.value;
}

function paint(text: string, color: string, stream: NodeJS.WriteStream) {
  return stream.isTTY && process.env.NO_COLOR === undefined
    ? `\x1b[${color}m${text}\x1b[0m`
    : text;
}

if (!json && args.length === 1 && args[0] === "--help") {
  console.log(
    usage +
      "\nRebase local values onto the example. --json emits one value-free result.",
  );
} else {
  const result = await run();
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
    console.log(paint("env-sync: " + result.status, "1;36", process.stdout));
    for (const [label, keys] of Object.entries(result.keys)) {
      console.log(`  ${label} (${keys.length}): ${keys.join(", ") || "—"}`);
    }
    if (result.status === "updated")
      console.log(
        "  Backup: " +
          (result.backup === null
            ? "none (you approved this update without one)"
            : JSON.stringify(result.backup)),
      );
  }
  process.exitCode = result.ok ? 0 : result.code === "USAGE" ? 2 : 1;
}
