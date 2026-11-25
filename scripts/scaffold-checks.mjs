import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runRemovalBatch } from "./scaffold-terminal.mjs";

const entry = fileURLToPath(new URL("./scaffold-bench.mjs", import.meta.url));
function invoke(...args) {
  return spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 300_000 });
}
function run(...args) {
  const result = invoke(...args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function variables(text) {
  return new Map(
    text
      .trimEnd()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split("=")),
  );
}

test("manual scaffold lifecycle", async (t) => {
  const root = run("build");
  t.after(() => {
    if (existsSync(root)) run("teardown", root);
  });
  const repo = join(root, "repo");
  const paths = readdirSync(repo, { recursive: true }).filter(
    (p) => p !== ".git" && !p.startsWith(".git/"),
  );
  const dirs = paths.filter((p) => lstatSync(join(repo, p)).isDirectory());
  assert.equal(dirs.length + 1, 13);
  assert.deepEqual(new Set(dirs.map((p) => p.split("/").length)), new Set([1, 2, 3, 4]));
  for (const ext of [".js", ".json", ".txt"]) {
    assert.equal(
      paths.filter((p) => basename(p).startsWith("noise-") && extname(p) === ext).length,
      416,
    );
  }
  run("initial", root);
  const { mappings } = JSON.parse(readFileSync(join(repo, ".envsync.json"), "utf8"));
  assert.equal(mappings.length, 26);
  assert.equal(mappings.flatMap((m) => m.targets).length, 39);
  const read = (file) => readFileSync(join(repo, file), "utf8");
  const originals = new Map(mappings.map(({ source }) => [source, read(source)]));

  await t.test("refuses unexpected input before rewriting any synthetic files", () => {
    const last = mappings.at(-1).targets.at(-1);
    const before = read(last);
    writeFileSync(join(repo, last), "KEEP=hand-edited\n");
    const result = invoke("mutate", root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unexpected fixture file/);
    assert.equal(read(last), "KEEP=hand-edited\n");
    for (const [source, data] of originals) assert.ok(read(source) === data);
    writeFileSync(join(repo, last), before);
  });

  await t.test("fixed template and target edit counts", () => {
    run("mutate", root);
    for (const { source, targets } of mappings) {
      const old = variables(originals.get(source));
      const revised = variables(read(source));
      const original = [...old];
      assert.equal(old.size, 4096);
      assert.equal(original.filter(([, v]) => v === "").length, 2048);
      assert.equal([...revised.keys()].filter((k) => !old.has(k)).length, 16);
      assert.equal(original.filter(([k]) => !revised.has(k)).length, 16);
      assert.equal(original.filter(([k, v]) => revised.has(k) && revised.get(k) !== v).length, 64);
      for (const target of targets) {
        const local = variables(read(target));
        assert.equal(local.size, 4104);
        assert.ok(original.every(([k]) => local.has(k)));
        assert.equal(original.filter(([k, v]) => v === "" && local.get(k) !== v).length, 64);
        assert.equal(original.filter(([k, v]) => v !== "" && local.get(k) !== v).length, 64);
      }
    }
  });
  run("teardown", root);
  assert.equal(existsSync(root), false);
});

test("teardown refuses an unmarked directory or copied marker", (t) => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "env-sync-node-scaffold-"));
  t.after(() => rmSync(root, { recursive: true }));
  assert.equal(invoke("teardown", root).status, 1);
  writeFileSync(join(root, ".env-sync-scaffold-v1"), "copied from elsewhere");
  assert.equal(invoke("teardown", root).status, 1);
  assert.ok(existsSync(root));
});

for (const [list, question] of [
  ["OLD", "Continue without an automatic backup?"],
  ["OTHER", "Remove these keys and continue?"],
]) {
  test(`no approval for ${list}: ${question}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "env-sync-terminal-test-"));
    t.after(() => rmSync(root, { recursive: true }));
    const entry = join(root, "prompt.mjs");
    writeFileSync(
      entry,
      `import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const r = createInterface({input: process.stdin, output: process.stderr});
console.error('Keys to remove (1): ${list}');
r.question('${question} [y/N] ', a => {writeFileSync('answer', a); r.close()});`,
    );
    await assert.rejects(
      runRemovalBatch({ cwd: root, env: { TERM: "dumb" }, entry, removals: [["OLD"]] }),
      /No approval sent/,
    );
    assert.equal(existsSync(join(root, "answer")), false);
  });
}
