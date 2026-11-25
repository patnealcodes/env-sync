import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const marker = "SENSITIVE_fixture_never_render";
let root: string, home: string, repo: string, target: string, example: string;
function env() {
  const { ENV_SYNC_BACKUP_DIR: _override, ...base } = process.env;
  return {
    ...base,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "absent"),
  };
}
function git(...args: string[]) {
  execFileSync("git", ["-C", repo, ...args], { env: env(), stdio: "pipe" });
}
function run(args = ["--json", example, target], extra = {}) {
  const out = spawnSync(process.execPath, [cli, ...args], {
    cwd: home,
    encoding: "utf8",
    env: { ...env(), ...extra },
  });
  expect(out.stdout + out.stderr).not.toContain(marker);
  return out;
}
beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "env-sync-test-")));
  home = join(root, "home");
  repo = join(root, "work tree");
  mkdirSync(home);
  mkdirSync(repo);
  example = join(repo, ".env.example");
  target = join(repo, ".env.local");
  writeFileSync(
    example,
    "# template " + marker + "\nA=default\nNEW=example-" + marker + "\n",
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function expectPrivate(file: string) {
  if (process.platform !== "win32") {
    expect(statSync(file).mode & 0o777).toBe(0o600);
    return;
  }
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
    $acl = Get-Acl -LiteralPath $env:ENV_SYNC_TEST_PATH
    $r = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if (!$acl.AreAccessRulesProtected -or $r.Count -ne 1 -or $r[0].IdentityReference.Value -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) {exit 1}
  `,
    ],
    { env: { ...env(), ENV_SYNC_TEST_PATH: file } },
  );
  expect(result.status).toBe(0);
}

it("updates an ignored local file, rotates a private backup, and makes an identical run a no-op", () => {
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), ".env.local\n");
  const original = `A="${marker}" # local note\nOLD=private\n`;
  writeFileSync(target, original);
  const refused = run();
  expect(JSON.parse(refused.stdout)).toMatchObject({
    ok: false,
    code: "REMOVAL_CONFIRMATION_REQUIRED",
    removed: ["OLD"],
  });
  expect(readFileSync(target, "utf8")).toBe(original);
  expect(readdirSync(home)).toEqual([]);
  const updated = run(["--json", "--remove-key", "OLD", example, target]);
  expect(updated.status, updated.stdout).toBe(0);
  expect(updated.stderr).toBe("");
  const report = JSON.parse(updated.stdout);
  expect(report).toMatchObject({
    ok: true,
    status: "updated",
    keys: { added: ["NEW"], preserved: ["A"], removed: ["OLD"] },
  });
  expect(dirname(report.backup)).toBe(join(home, ".env-sync-backups"));
  expect(readFileSync(report.backup, "utf8")).toBe(original);
  const merged = readFileSync(target, "utf8");
  expect(merged).toBe(
    `# template ${marker}\nA="${marker}"\nNEW=example-${marker}\n`,
  );
  expectPrivate(target);
  expectPrivate(report.backup);
  const t = statSync(target, { bigint: true }).mtimeNs,
    b = statSync(report.backup, { bigint: true }).mtimeNs;
  expect(JSON.parse(run().stdout).status).toBe("unchanged");
  expect(statSync(target, { bigint: true }).mtimeNs).toBe(t);
  expect(statSync(report.backup, { bigint: true }).mtimeNs).toBe(b);
  writeFileSync(example, "A=default\n");
  expect(run(["--remove-key", "NEW", example, target]).stdout).toContain(
    "Status: updated",
  );
  expect(readFileSync(report.backup, "utf8")).toBe(merged);
  expect(readdirSync(dirname(report.backup))).toHaveLength(1);
}, 60000);

it("creates a missing target outside Git without a backup", () => {
  const result = run();
  expect(result.status, result.stdout).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("created");
  expect(readFileSync(target)).toEqual(readFileSync(example));
  expectPrivate(target);
  expect(readdirSync(home)).toEqual([]);
}, 30000);

it("refuses missing ignore rules and tracked files, even with a matching ignore rule", () => {
  git("init", "-q");
  const warning = run([example, target]);
  expect(warning.status).toBe(1);
  expect(warning.stderr).toContain("!! GIT SAFETY WARNING");
  expect(existsSync(target)).toBe(false);
  writeFileSync(join(repo, ".gitignore"), ".env.local\n");
  writeFileSync(target, `A=${marker}\n`);
  git("add", "-f", "--", ".env.local");
  for (const overrides of [{}, { GIT_INDEX_FILE: join(root, "bogus-index") }]) {
    const r = run(undefined, overrides);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).code).toBe("GIT_SAFETY");
  }
  expect(readFileSync(target, "utf8")).toBe(`A=${marker}\n`);
  expect(readdirSync(home)).toEqual([]);
});

it("--no-backup skips backup storage without prompting and still enforces Git safety", () => {
  const args = ["--no-backup", "--json", example, target];
  git("init", "-q");
  writeFileSync(target, `OLD=${marker}`);
  expect(JSON.parse(run(args).stdout).code).toBe("GIT_SAFETY");
  expect(readFileSync(target, "utf8")).toBe(`OLD=${marker}`);
  writeFileSync(join(repo, ".gitignore"), ".env.local\n");
  expect(JSON.parse(run(args).stdout).code).toBe(
    "REMOVAL_CONFIRMATION_REQUIRED",
  );
  expect(JSON.parse(run(["--remove-key", "OTHER", ...args]).stdout).code).toBe(
    "REMOVAL_CONFIRMATION_REQUIRED",
  );
  const updated = run(["--remove-key", "OLD", ...args]);
  expect(updated.status).toBe(0);
  expect(updated.stderr).toBe("");
  expect(JSON.parse(updated.stdout)).toMatchObject({
    status: "updated",
    backup: null,
    keys: { removed: ["OLD"] },
  });
  expect(readFileSync(target)).toEqual(readFileSync(example));
  expect(readdirSync(home)).toEqual([]);
}, 30000);

it("preserves the target when the backup cannot be saved", () => {
  writeFileSync(join(home, ".env-sync-backups"), "blocked");
  writeFileSync(target, `A=${marker}`);
  expect(JSON.parse(run().stdout)).toMatchObject({
    ok: false,
    code: "BACKUP_UNAVAILABLE",
  });
  const piped = spawnSync(process.execPath, [cli, example, target], {
    env: env(),
    encoding: "utf8",
    input: "y\n",
  });
  expect(piped.status).toBe(1);
  expect(piped.stderr).not.toContain("[y/N]");
  expect(readFileSync(target, "utf8")).toBe(`A=${marker}`);
  expect(readdirSync(repo).sort()).toEqual([".env.example", ".env.local"]);
}, 30000);

it("uses a dedicated backup directory outside Git without writing to home", () => {
  writeFileSync(join(home, ".env-sync-backups"), "blocked");
  const store = join(root, "approved private backups");
  writeFileSync(target, `OLD=${marker}`);
  const out = run(["--json", "--remove-key", "OLD", example, target], {
    ENV_SYNC_BACKUP_DIR: store,
  });
  expect(out.status, out.stdout).toBe(0);
  const backup = JSON.parse(out.stdout).backup;
  expect(dirname(backup)).toBe(store);
  expect(readFileSync(backup, "utf8")).toBe(`OLD=${marker}`);
  expectPrivate(backup);
}, 30000);

it("refuses aliases, non-UTF8 and malformed input without disclosing raw data", () => {
  expect(JSON.parse(run(["--json", example, example]).stdout).code).toBe(
    "UNSAFE_PATH",
  );
  linkSync(example, target);
  expect(JSON.parse(run().stdout).code).toBe("UNSAFE_PATH");
  rmSync(target);
  if (process.platform !== "win32") {
    symlinkSync(example, target);
    expect(JSON.parse(run().stdout).code).toBe("UNSAFE_PATH");
    rmSync(target);
  }
  writeFileSync(target, Buffer.from([255]));
  expect(JSON.parse(run().stdout).code).toBe("INVALID_ENV");
  writeFileSync(target, `A=foo\n${marker}`);
  expect(JSON.parse(run().stdout).code).toBe("INVALID_ENV");
  expect(readdirSync(home)).toEqual([]);
});

it("refuses a custom backup location inside Git", () => {
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), ".env.local\n");
  writeFileSync(target, `OLD=${marker}`);
  const store = join(repo, "backup-dir");
  expect(
    JSON.parse(
      run(["--json", "--remove-key", "OLD", example, target], {
        ENV_SYNC_BACKUP_DIR: store,
      }).stdout,
    ).code,
  ).toBe("GIT_SAFETY");
  expect(existsSync(store)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe(`OLD=${marker}`);
}, 30000);

// Exercise the actual readline/TTY boundary on macOS, without accepting piped consent.
it.skipIf(!existsSync("/usr/bin/expect")).each([
  ["backup", "y", true],
  ["backup", "enter", false],
  ["backup", "interrupt", false],
  ["backup", "edit-then-y", false],
  ["removal", "y", true],
  ["removal", "enter", false],
  ["removal", "interrupt", false],
  ["removal", "edit-then-y", false],
] as const)(
  "handles interactive %s confirmation: %s",
  (kind, answer, updated) => {
    writeFileSync(join(home, ".env-sync-backups"), "blocked");
    writeFileSync(target, `OLD=${marker}`);
    const term = spawnSync("/usr/bin/expect", ["-f", "-"], {
      env: {
        ...env(),
        NODE: process.execPath,
        CLI: cli,
        EXAMPLE: example,
        LOCAL: target,
        ANSWER: answer,
        KIND: kind,
        NO_COLOR: "1",
      },
      encoding: "utf8",
      timeout: 15000,
      input: `set timeout 8
if {$env(KIND) eq "backup"} {set flags {--remove-key OLD}} else {set flags {--no-backup}}
spawn -noecho $env(NODE) $env(CLI) {*}$flags $env(EXAMPLE) $env(LOCAL)
expect {\n  -exact {[y/N]} {}\n  timeout {exit 99}\n  eof {exit 98}\n}
switch $env(ANSWER) {
  enter {send -- "\\r"}
  interrupt {send -- "\\003"}
  edit-then-y {set f [open $env(LOCAL) w]; puts -nonewline $f "CHANGED=1"; close $f; send -- "y\\r"}
  default {send -- "y\\r"}
}
expect eof
exit [lindex [wait] 3]\n`,
    });
    expect(term.stdout + term.stderr).not.toContain(marker);
    expect(term.stdout).toContain("██  ██████████   env-sync");
    expect(term.stdout).toContain("Keys to remove (1): OLD");
    expect(term.stdout).toContain(
      kind === "removal"
        ? "Remove these keys"
        : "Continue without an automatic backup",
    );
    expect(term.status).toBe(updated ? 0 : 1);
    expect(readFileSync(target, "utf8")).toBe(
      updated
        ? readFileSync(example, "utf8")
        : answer === "edit-then-y"
          ? "CHANGED=1"
          : `OLD=${marker}`,
    );
    expect(readdirSync(repo).sort()).toEqual([".env.example", ".env.local"]);
  },
  30000,
);

it("scans filenames only and appends new sources without changing existing mappings or dotenv files", () => {
  const file = join(home, ".envsync.json");
  mkdirSync(join(home, "client"));
  mkdirSync(join(home, "node_modules"));
  for (const name of [
    ".env.example",
    "client/env.sample",
    "client/.env.production",
    "node_modules/.env.example",
  ])
    writeFileSync(join(home, name), marker);
  const scan = () => run(["--json", "--scan"]);
  const first = scan();
  expect(first.status, first.stdout).toBe(0);
  const entries = [
    { source: ".env.example", targets: [".env"] },
    { source: "client/env.sample", targets: ["client/.env"] },
  ];
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mappings: entries });
  expect(existsSync(join(home, ".env"))).toBe(false);
  expect(existsSync(join(home, "client", ".env"))).toBe(false);
  entries[0].targets = [".env.custom"];
  const custom = JSON.stringify({ mappings: entries });
  writeFileSync(file, custom);
  expect(scan().status).toBe(0);
  expect(readFileSync(file, "utf8")).toBe(custom);
  writeFileSync(join(home, "client", ".env.local.example"), marker);
  expect(scan().status).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8")).mappings).toEqual([
    ...entries,
    { source: "client/.env.local.example", targets: ["client/.env.local"] },
  ]);
});

it("normal CLI bootstraps .env and uses its settings on subsequent runs", () => {
  const fixture = new URL("../.env.example", import.meta.url);
  writeFileSync(example, readFileSync(fixture));
  const settings = join(repo, ".env");
  const invoke = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: repo,
      env: env(),
      encoding: "utf8",
    });
  git("init", "-q");
  writeFileSync(
    join(repo, ".gitignore"),
    ".env\n.env.local\n.env.test.local\n",
  );
  const initial = invoke();
  expect(initial.status, initial.stderr).toBe(0);
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(settings)).toEqual(readFileSync(example));
  const setTargets = (targets: string[]) =>
    writeFileSync(
      join(repo, ".envsync.json"),
      JSON.stringify({ mappings: [{ source: ".env.example", targets }] }),
    );
  setTargets([".env", ".env.local", ".env.test.local"]);
  const batch = invoke();
  expect(batch.status).toBe(0);
  expect(batch.stdout).toContain("env-sync · 3 files\n\n[1/3] .env\n");
  expect(batch.stdout).toContain("\n\n[2/3] .env.local\n");
  expect(batch.stdout).toContain("\n\n[3/3] .env.test.local\n");
  expect(batch.stdout).toContain("+ Added (4)");
  expect(batch.stdout).toContain("= Preserved (4)");
  expect(batch.stdout).not.toContain("\x1b");
  expect(readFileSync(settings)).toEqual(readFileSync(example));
  setTargets([".env.local"]);
  for (const name of [".env.local", ".env.test.local"])
    expect(readFileSync(join(repo, name))).toEqual(readFileSync(example));
  const store = join(root, "private backups");
  const configure = (extra: string) =>
    writeFileSync(
      settings,
      `ENV_SYNC_JSON=true\nENV_SYNC_BACKUP_DIR="${store}"\nNODE_OPTIONS=${marker}\n${extra}`,
    );
  configure("ENV_SYNC_HELP=true");
  writeFileSync(target, `OLD=${marker}`);
  expect(invoke().stdout).toContain("Usage: env-sync");
  expect(readFileSync(target, "utf8")).toBe(`OLD=${marker}`);
  configure("ENV_SYNC_NO_BACKUP=true");
  const explicit = invoke(example, join(repo, ".env.test.local"));
  expect(JSON.parse(explicit.stdout).status).toBe("unchanged");
  expect(readFileSync(target, "utf8")).toBe(`OLD=${marker}`);
  expect(JSON.parse(invoke().stdout).code).toBe(
    "REMOVAL_CONFIRMATION_REQUIRED",
  );
  const skipped = invoke("--remove-key", "OLD");
  expect(skipped.status, skipped.stderr).toBe(0);
  expect(skipped.stdout + skipped.stderr).not.toContain(marker);
  expect(JSON.parse(skipped.stdout)).toMatchObject({
    status: "updated",
    backup: null,
  });
  expect(existsSync(store)).toBe(false);
  configure("ENV_SYNC_NO_BACKUP=false");
  writeFileSync(target, `OLD=${marker}`);
  const saved = invoke("--remove-key", "OLD");
  expect(saved.status, saved.stderr).toBe(0);
  const backup = JSON.parse(saved.stdout).backup;
  expect(dirname(backup)).toBe(store);
  expect(readFileSync(backup, "utf8")).toBe(`OLD=${marker}`);
  configure(`ENV_SYNC_NO_BACKUP=${marker}`);
  const invalid = invoke();
  expect(invalid.status).not.toBe(0);
  expect(invalid.stderr + invalid.stdout).not.toContain(marker);
}, 60000);

it("syncs only named monorepo outputs, using each sibling template and baseline", () => {
  const client = join(repo, "apps", "client");
  mkdirSync(client, { recursive: true });
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), ".env\n.env.local\n");
  writeFileSync(example, "ROOT=old\n");
  writeFileSync(join(client, ".env.example"), "WEB=old\n");
  git("add", "--", ".env.example", "apps/client/.env.example");
  const tree = execFileSync("git", ["-C", repo, "write-tree"], {
    encoding: "utf8",
    env: env(),
  }).trim();
  git("update-ref", "refs/tags/base", tree);
  writeFileSync(example, "ROOT=new\n");
  writeFileSync(join(client, ".env.example"), "WEB=new\n");
  writeFileSync(join(client, ".env"), "WEB=old\n");
  writeFileSync(
    join(repo, ".envsync.json"),
    JSON.stringify({
      mappings: [
        { source: ".env.example", targets: [".env.local"] },
        { source: "apps/client/.env.example", targets: ["apps/client/.env"] },
      ],
    }),
  );
  const out = spawnSync(process.execPath, [cli, "--json", "--since", "base"], {
    cwd: repo,
    env: env(),
    encoding: "utf8",
  });
  expect(out.status, out.stdout).toBe(0);
  const reports = out.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(reports).toMatchObject([
    { status: "created", keys: { added: ["ROOT"] } },
    {
      status: "unchanged",
      review: [{ key: "WEB", reason: "PREVIOUS_DEFAULT" }],
    },
  ]);
  expect(readFileSync(target, "utf8")).toBe("ROOT=new\n");
  expect(existsSync(join(client, ".env.local"))).toBe(false);
}, 30000);

it("creates only the designated outputs for each named example", () => {
  const client = join(home, "apps", "client");
  mkdirSync(client, { recursive: true });
  writeFileSync(join(home, ".env.example"), "ROOT=one\n");
  writeFileSync(join(client, "env.example"), "WEB=two\n");
  writeFileSync(join(client, ".env.example"), "WRONG=unused\n");
  writeFileSync(
    join(home, ".envsync.json"),
    JSON.stringify({
      mappings: [
        { source: ".env.example", targets: [".env", ".env.test.local"] },
        {
          source: "apps/client/env.example",
          targets: ["apps/client/.env.local"],
        },
      ],
    }),
  );
  const out = run(["--json"]);
  expect(out.status, out.stdout).toBe(0);
  for (const name of [".env", ".env.test.local"])
    expect(readFileSync(join(home, name), "utf8")).toBe("ROOT=one\n");
  expect(readFileSync(join(client, ".env.local"), "utf8")).toBe("WEB=two\n");
  expect(existsSync(join(client, ".env.test.local"))).toBe(false);
  expect(existsSync(join(home, ".env.local"))).toBe(false);
}, 30000);

it.each([
  "../.env",
  "/apps/client/.env",
  "C:/apps/.env",
  ".env.example",
  "./.env.local",
  ".env.sample",
])("rejects unsafe manifest target: %s", (path) => {
  writeFileSync(
    join(home, ".envsync.json"),
    JSON.stringify({ mappings: [{ source: ".env.example", targets: [path] }] }),
  );
  expect(JSON.parse(run(["--json"]).stdout).code).toBe("INVALID_MANIFEST");
  expect(readdirSync(home)).toEqual([".envsync.json"]);
});

it("does not overwrite malformed manifests or guess between conflicting templates", () => {
  writeFileSync(join(home, ".env.example"), marker);
  writeFileSync(join(home, "env.sample"), marker);
  for (const args of [["--json"], ["--scan", "--json"]]) {
    const out = run(args);
    expect(JSON.parse(out.stdout).code).toBe("INVALID_MANIFEST");
    expect(existsSync(join(home, ".envsync.json"))).toBe(false);
    expect(existsSync(join(home, ".env"))).toBe(false);
  }
  for (const bad of [
    "{" + marker,
    JSON.stringify({ mappings: [{ source: ".env.example", target: ".env" }] }),
  ]) {
    writeFileSync(join(home, ".envsync.json"), bad);
    expect(JSON.parse(run(["--json", "--scan"]).stdout).code).toBe(
      "INVALID_MANIFEST",
    );
    expect(readFileSync(join(home, ".envsync.json"), "utf8")).toBe(bad);
  }
});

it("without a manifest syncs only current-directory templates and creates no manifest", () => {
  writeFileSync(join(home, "env.sample"), "ROOT=yes");
  mkdirSync(join(home, "app"));
  writeFileSync(join(home, "app", ".env.example"), "APP=yes");
  expect(run(["--json"], { ENV_SYNC_TARGET_FILES: "app/.env" }).status).toBe(0);
  expect(readFileSync(join(home, ".env"), "utf8")).toBe("ROOT=yes");
  expect(existsSync(join(home, "app", ".env"))).toBe(false);
  expect(existsSync(join(home, ".envsync.json"))).toBe(false);
});

it("does not follow a linked target directory or fall back to the root template", () => {
  writeFileSync(join(home, ".env.example"), "ROOT=1");
  mkdirSync(join(home, "client"));
  const mapping = (dir: string) =>
    writeFileSync(
      join(home, ".envsync.json"),
      JSON.stringify({
        mappings: [{ source: dir + "/.env.example", targets: [dir + "/.env"] }],
      }),
    );
  mapping("client");
  const missing = run(["--json"]);
  expect(JSON.parse(missing.stdout).code).toBe("IO");
  expect(existsSync(join(home, "client", ".env"))).toBe(false);
  symlinkSync(
    repo,
    join(home, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  mapping("linked");
  const linked = run(["--json"]);
  expect(JSON.parse(linked.stdout).code).toBe("UNSAFE_PATH");
  expect(existsSync(join(repo, ".env"))).toBe(false);
});

it("compares a historical template without changing local overrides or revealing values", () => {
  git("init", "-q");
  writeFileSync(join(repo, ".gitignore"), ".env.local\n");
  const nested = join(repo, "config files");
  mkdirSync(nested);
  const template = join(nested, ".env.example");
  writeFileSync(
    template,
    `REGION=\nWAIT=1\nAPI=/v1\nMATCH=old\nNOTE=ok # old\n`,
  );
  git("add", "--", template);
  const tree = execFileSync("git", ["-C", repo, "write-tree"], {
    encoding: "utf8",
    env: env(),
  }).trim();
  git("update-ref", "refs/tags/baseline", tree);
  writeFileSync(
    template,
    `REGION=us\nWAIT=1000\nAPI=/v2\nMATCH=new\nNOTE=ok # new\n`,
  );
  writeFileSync(
    target,
    `REGION=eu\nWAIT=1\nAPI=${marker}\nMATCH=new\nNOTE=ok # new\n`,
  );
  const out = run(["--since", "baseline", "--json", template, target]);
  expect(out.status, out.stdout).toBe(0);
  expect(JSON.parse(out.stdout)).toMatchObject({
    status: "unchanged",
    review: [
      { key: "REGION", reason: "DEFAULT_ADDED" },
      { key: "WAIT", reason: "PREVIOUS_DEFAULT" },
      { key: "API", reason: "OVERRIDE" },
    ],
  });
  const missing = run(["--since", "missing-ref", "--json", template, target]);
  expect(JSON.parse(missing.stdout).code).toBe("BASELINE_UNAVAILABLE");
  expect(readdirSync(home)).toEqual([]);
});

it("fails closed when Git cannot run and returns JSON on usage errors", () => {
  const missing = run(undefined, { PATH: "" });
  expect(JSON.parse(missing.stdout).code).toBe("GIT_SAFETY");
  const bad = run(["--json", example]);
  expect(bad.status).toBe(2);
  expect(JSON.parse(bad.stdout).code).toBe("USAGE");
});
