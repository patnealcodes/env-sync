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
  return {
    ...process.env,
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

it("preserves the target when the backup cannot be saved", () => {
  writeFileSync(join(home, ".env-sync-backups"), "blocked");
  writeFileSync(target, `A=${marker}`);
  expect(JSON.parse(run().stdout).ok).toBe(false);
  expect(readFileSync(target, "utf8")).toBe(`A=${marker}`);
  expect(readdirSync(repo).sort()).toEqual([".env.example", ".env.local"]);
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

it("fails closed when Git cannot run and returns JSON on usage errors", () => {
  const missing = run(undefined, { PATH: "" });
  expect(JSON.parse(missing.stdout).code).toBe("GIT_SAFETY");
  const bad = run(["--json", example]);
  expect(bad.status).toBe(2);
  expect(JSON.parse(bad.stdout).code).toBe("USAGE");
});
