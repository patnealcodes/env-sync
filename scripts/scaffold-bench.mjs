import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { runRemovalBatch } from "./scaffold-terminal.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const prefix = "env-sync-node-scaffold-";
const marker = ".env-sync-scaffold-v1";
const tmp = realpathSync.native(tmpdir());
const pad = (i, width = 2) => String(i).padStart(width, "0");
const keys = Array.from({ length: 4096 }, (_, i) => `VAR_${pad(i, 4)}`);
const dropped = keys.slice(-16);
const extras = (id) => Array.from({ length: 8 }, (_, i) => `LOCAL_${pad(id)}_${pad(i)}`);
const noise = Array.from({ length: 96 }, (_, i) => {
  const [ext, contents] = [
    ["txt", "dummy\n"],
    ["json", "{}\n"],
    ["js", "// dummy\n"],
  ][i % 3];
  return [`noise-${pad(i, 3)}.${ext}`, contents];
});
const dirs = [""];
for (let i = 0; i < 3; i++) {
  const service = `service-${pad(i)}`;
  dirs.push(
    service,
    `${service}/packages`,
    `${service}/packages/worker`,
    `${service}/packages/worker/config`,
  );
}
const specs = dirs
  .flatMap((dir, i) => {
    const odd = dir && dir.split("/").length % 2;
    return [
      {
        index: 2 * i,
        dir,
        source: join(dir, odd ? "env.sample" : ".env.example"),
        targets: [join(dir, ".env"), join(dir, ".env.local")],
      },
      {
        index: 2 * i + 1,
        dir,
        source: join(dir, odd ? "env.test.example" : ".env.test.sample"),
        targets: [join(dir, ".env.test")],
      },
    ];
  })
  .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
const targets = new Set(specs.flatMap((s) => s.targets));

function original(s) {
  return new Map(keys.map((key, i) => [key, i % 2 ? `default-${pad(s.index)}-${pad(i, 4)}` : ""]));
}
function revised(s) {
  const values = original(s);
  for (const k of dropped) values.delete(k);
  // Half the changed defaults have also been overridden locally.
  for (let i = 65; i < 193; i += 2) values.set(keys[i], `revised-${pad(s.index)}-${pad(i, 4)}`);
  for (let i = 0; i < 16; i++) values.set(`NEW_${pad(i)}`, i % 2 ? `added-${pad(i)}` : "");
  return values;
}
function edited(s, id) {
  const values = original(s);
  for (let i = 0; i < 128; i++) values.set(keys[i], `local-${pad(id)}-${pad(i, 4)}`);
  for (const k of extras(id)) values.set(k, "local-only");
  return values;
}
function render(s, values) {
  const eol = s.index % 2 ? "\r\n" : "\n";
  return (
    `# synthetic template ${s.index}${eol}` +
    Array.from(values, ([k, v]) => `${k}=${v}${eol}`).join("")
  );
}
function manifest(fanout) {
  return {
    mappings: specs.map((s) => ({
      source: s.source,
      targets: fanout ? s.targets : s.targets.slice(0, 1),
    })),
  };
}

function check(ok, message) {
  if (!ok) throw new Error(message);
}
function stat(path) {
  return lstatSync(path, { throwIfNoEntry: false });
}
function regular(path) {
  const info = stat(path);
  return info?.isFile() && info.nlink === 1;
}
function checkBytes(path, contents) {
  check(
    regular(path) && readFileSync(path).equals(Buffer.from(contents)),
    `Unexpected fixture file: ${path}. No timing accepted.`,
  );
}
function owned(path) {
  const root = resolve(path);
  check(
    dirname(root) === tmp && basename(root).startsWith(prefix) && stat(root)?.isDirectory(),
    "Expected the temporary directory printed by build.",
  );
  checkBytes(join(root, marker), root);
  return root;
}
function environment(root) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !/^(?:ENV_SYNC_|GIT_|NODE_OPTIONS$|NODE_PATH$)/i.test(k),
      ),
    ),
    HOME: root,
    USERPROFILE: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ENV_SYNC_BACKUP_DIR: join(root, "backups"),
    NO_COLOR: "1",
    TERM: "dumb",
    LC_ALL: "C",
  };
}
function command(root, program, args) {
  const out = spawnSync(program, args, {
    cwd: join(root, "repo"),
    env: environment(root),
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 300_000,
  });
  check(
    !out.error && out.status === 0,
    `${basename(program)} failed in the fixture. No timing accepted.`,
  );
  return out.stdout;
}
function build() {
  const root = mkdtempSync(join(tmp, prefix));
  try {
    writeFileSync(join(root, marker), root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    command(root, "git", ["init", "-q", "--template="]);
    writeFileSync(join(repo, ".gitignore"), ".env\n.env.local\n.env.test\n");
    for (const dir of dirs) {
      if (dir) mkdirSync(join(repo, dir));
      for (const [name, data] of noise) writeFileSync(join(repo, dir, name), data);
    }
    for (const s of specs) writeFileSync(join(repo, s.source), render(s, original(s)));
    command(root, "git", ["add", "--", ".gitignore", ...specs.map((s) => s.source)]);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true }); // Exclusively created here.
    throw error;
  }
}
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Expected JSON from the fixture. No timing accepted.");
  }
}
function checkManifest(path, fanout) {
  check(
    regular(path) && isDeepStrictEqual(parseJson(readFileSync(path, "utf8")), manifest(fanout)),
    "Unexpected manifest mappings.",
  );
}
function checkFiles(root, phase) {
  const repo = join(root, "repo");
  const fresh = phase === "fresh";
  const changed = phase === "mutated" || phase === "updated";
  for (const dir of dirs) {
    const path = join(repo, dir);
    check(stat(path)?.isDirectory(), `Expected a real fixture directory: ${path}`);
    const names = new Set(noise.map(([name]) => name));
    for (const child of dirs) {
      if (child && dirname(child) === (dir || ".")) names.add(basename(child));
    }
    for (const s of specs.filter((s) => s.dir === dir)) {
      names.add(basename(s.source));
      if (!fresh) for (const target of s.targets) names.add(basename(target));
    }
    if (!dir) {
      names.add(".git").add(".gitignore");
      if (!fresh) names.add(".envsync.json");
    }
    check(isDeepStrictEqual(new Set(readdirSync(path)), names), `Unexpected inventory in ${path}.`);
  }
  check(stat(join(repo, ".git"))?.isDirectory(), "Expected the generated Git repository.");
  const ignored = command(root, "git", [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  check(
    isDeepStrictEqual(new Set(ignored.split("\0").filter(Boolean)), fresh ? new Set() : targets),
    "Unexpected ignored target set.",
  );
  if (!fresh) checkManifest(join(repo, ".envsync.json"), true);
  const backups = join(root, "backups");
  check(
    phase === "updated" ? stat(backups)?.isDirectory() : !stat(backups),
    "Unexpected backup directory.",
  );
  const expectedBackups = new Set();
  for (const s of specs) {
    const template = changed ? revised(s) : original(s);
    const data = render(s, template);
    checkBytes(join(repo, s.source), data);
    if (fresh) continue;
    for (const [j, t] of s.targets.entries()) {
      const path = join(repo, t);
      if (!changed) {
        checkBytes(path, data);
        continue;
      }
      const local = edited(s, 2 * s.index + j);
      const before = render(s, local);
      if (phase === "mutated") {
        checkBytes(path, before);
        continue;
      }
      // Independent of the production parser/merge. Preserve even explicitly blank local values.
      checkBytes(
        path,
        render(
          s,
          Array.from(template, ([k, v]) => [k, local.get(k) ?? v]),
        ),
      );
      const name = createHash("sha256").update(path).digest("hex") + ".bak";
      expectedBackups.add(name);
      checkBytes(join(backups, name), before);
    }
  }
  if (phase === "updated")
    check(
      isDeepStrictEqual(new Set(readdirSync(backups)), expectedBackups),
      "Unexpected backup set.",
    );
}
function initial(root) {
  checkFiles(root, "fresh");
  const start = performance.now();
  const scanned = command(root, process.execPath, [cli, "--scan", "--json"]);
  const scan = performance.now() - start;
  check(
    isDeepStrictEqual(parseJson(scanned), { ok: true, status: "created", added: specs.length }),
    "Unexpected scan result.",
  );
  const path = join(root, "repo", ".envsync.json");
  checkManifest(path, false);
  writeFileSync(path, JSON.stringify(manifest(true), null, 2) + "\n");
  const startCreate = performance.now();
  const created = command(root, process.execPath, [cli, "--json"]);
  const create = performance.now() - startCreate;
  const reports = created.trimEnd().split("\n").map(parseJson);
  check(
    reports.length === targets.size &&
      reports.every((r) => r.ok === true && r.status === "created"),
    "Not all targets reported created.",
  );
  checkFiles(root, "created");
  return { scan, create };
}
function mutate(root) {
  checkFiles(root, "created"); // Validate every file before rewriting any.
  const repo = join(root, "repo");
  for (const s of specs) {
    writeFileSync(join(repo, s.source), render(s, revised(s)));
    for (const [j, t] of s.targets.entries())
      writeFileSync(join(repo, t), render(s, edited(s, 2 * s.index + j)));
  }
}
async function update(root) {
  checkFiles(root, "mutated");
  const removals = specs.flatMap((s) =>
    s.targets.map((_, j) => [...dropped, ...extras(2 * s.index + j)]),
  );
  const start = performance.now();
  await runRemovalBatch({ cwd: join(root, "repo"), env: environment(root), entry: cli, removals });
  const elapsed = performance.now() - start;
  checkFiles(root, "updated");
  return elapsed;
}
function times(row) {
  return Object.entries(row)
    .map(([k, ms]) => `${k}=${(ms / 1000).toFixed(3)}s`)
    .join("  ");
}
function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
}
const usage =
  "Usage: node scripts/scaffold-bench.mjs build | {initial|mutate|update|teardown} DIR | run [--rounds N]";
async function main([action, ...args]) {
  if (action === "--help") return console.log(usage);
  check(
    ["darwin", "linux"].includes(process.platform),
    "This benchmark requires macOS or Linux for terminal confirmation.",
  );
  if (["initial", "update", "run"].includes(action))
    check(stat(cli)?.isFile(), "Missing dist/cli.js. Run npm run build first.");
  if (action === "build" && !args.length) return console.log(build());
  if (action === "run") {
    const { values } = parseArgs({ args, options: { rounds: { type: "string", default: "3" } } });
    const rounds = Number(values.rounds);
    check(Number.isSafeInteger(rounds) && rounds > 0, "--rounds must be a positive integer.");
    console.log(
      `${dirs.length} project directories, ${dirs.length * noise.length} noise files, ${specs.length} templates, ${targets.size} targets, ${keys.length} variables/template`,
    );
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const root = build();
      try {
        const row = initial(root);
        mutate(root);
        const sample = { ...row, update: await update(root) };
        samples.push(sample);
        console.log(`round ${i + 1}: ${times(sample)}`);
      } finally {
        rmSync(owned(root), { recursive: true });
      }
    }
    const medians = Object.fromEntries(
      ["scan", "create", "update"].map((k) => [k, median(samples.map((s) => s[k]))]),
    );
    return console.log("median:", times(medians));
  }
  check(["initial", "mutate", "update", "teardown"].includes(action) && args.length === 1, usage);
  const root = owned(args[0]);
  if (action === "initial") console.log(times(initial(root)));
  if (action === "mutate") mutate(root);
  if (action === "update") console.log(times({ update: await update(root) }));
  if (action === "teardown") rmSync(root, { recursive: true });
}
try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
