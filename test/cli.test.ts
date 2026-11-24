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
  const updated = run();
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
  expect(run([example, target]).stdout).toContain("env-sync: updated");
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
  const updated = run(args);
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
  const out = run(undefined, { ENV_SYNC_BACKUP_DIR: store });
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
    JSON.parse(run(undefined, { ENV_SYNC_BACKUP_DIR: store }).stdout).code,
  ).toBe("GIT_SAFETY");
  expect(existsSync(store)).toBe(false);
  expect(readFileSync(target, "utf8")).toBe(`OLD=${marker}`);
}, 30000);

// Exercise the actual readline/TTY boundary on macOS, without accepting piped consent.
it.skipIf(!existsSync("/usr/bin/expect")).each([
  ["y", true],
  ["enter", false],
  ["interrupt", false],
  ["edit-then-y", false],
] as const)(
  "handles interactive backup failure: %s",
  (answer, updated) => {
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
        NO_COLOR: "1",
      },
      encoding: "utf8",
      timeout: 15000,
      input: `set timeout 8
spawn -noecho $env(NODE) $env(CLI) $env(EXAMPLE) $env(LOCAL)
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
    expect(term.stdout).toContain("Keys to remove (1): OLD");
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

it("fails closed when Git cannot run and returns JSON on usage errors", () => {
  const missing = run(undefined, { PATH: "" });
  expect(JSON.parse(missing.stdout).code).toBe("GIT_SAFETY");
  const bad = run(["--json", example]);
  expect(bad.status).toBe(2);
  expect(JSON.parse(bad.stdout).code).toBe("USAGE");
});
