import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

// Node has no public PTY allocator. Use the system script(1) to exercise the real
// interactive batch in a single invocation; never simulate isTTY or pipe blind consent.
export function runRemovalBatch({ cwd, env, entry, removals }) {
  const command = 'stty rows 24 cols 80 && exec "$BENCH_NODE" "$BENCH_ENTRY"';
  const mac = process.platform === "darwin";
  // BSD script needs a POSIX pipe (not libuv's socketpair) for redirected stdin.
  const [program, ...args] = mac
    ? [
        "/bin/bash",
        "-c",
        'exec /usr/bin/script -q /dev/null /bin/sh -c "$1" < <(/bin/cat)',
        "bash",
        command,
      ]
    : ["/usr/bin/script", "--quiet", "--return", "--command", command, "/dev/null"];
  const marker = "[y/N]";
  const question = `Remove these keys and continue? ${marker}`;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...env, SHELL: "/bin/sh", BENCH_NODE: process.execPath, BENCH_ENTRY: entry },
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 300_000,
    });
    let approved = 0;
    let tail = "";
    let failure;
    function stop(message) {
      failure ??= new Error(message);
      child.stdin.end();
      child.kill();
    }
    child.on("error", reject);
    child.stdin.on("error", () => stop("Could not answer the fixture prompt. No timing accepted."));
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      if (failure) return;
      tail += chunk;
      const pos = tail.indexOf(marker);
      if (pos >= 0) {
        const keys = removals[approved];
        const prompt = stripVTControlCharacters(tail.slice(0, pos + marker.length)).replaceAll(
          "\r\n",
          "\n",
        );
        if (
          !keys ||
          !prompt.endsWith(`\nKeys to remove (${keys.length}): ${keys.join(", ")}\n${question}`)
        ) {
          stop("Unexpected prompt or removal list. No approval sent.");
          return;
        }
        approved++;
        child.stdin.write("y\n");
        tail = tail.slice(pos + marker.length);
      }
      tail = tail.slice(-8192);
    });
    child.on("exit", () => child.stdin.end());
    child.on("close", (code) => {
      if (failure) reject(failure);
      else if (code !== 0 || approved !== removals.length)
        reject(
          new Error(
            "Interactive batch failed or did not confirm every target. Check script(1) is installed; no timing accepted.",
          ),
        );
      else resolve();
    });
  });
}
