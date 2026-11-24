#!/usr/bin/env node
import { syncEnv, type SyncResult } from "./sync.js";

const usage = "Usage: env-sync [--json] <example-file> <local-file>";
const args = process.argv.slice(2);
const json = args[0] === "--json";
if (json) args.shift();

function run(): SyncResult {
  const [example, local] = args;
  if (args.length !== 2 || !example || !local)
    return { ok: false, code: "USAGE", message: usage };
  return syncEnv(example, local);
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
  const result = run();
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
      console.log("  Backup: " + JSON.stringify(result.backup));
  }
  process.exitCode = result.ok ? 0 : result.code === "USAGE" ? 2 : 1;
}
