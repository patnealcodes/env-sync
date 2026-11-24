import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Windows PowerShell 5.1 is included with supported Windows desktops. Use a
// constant script, no profile, no interpolation of paths and no secret inputs.
const windowsProtection = `
$ErrorActionPreference = 'Stop'
$p = $env:ENV_SYNC_ITEM
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$isDir = [IO.Directory]::Exists($p)
if ($isDir) { $acl = [IO.Directory]::GetAccessControl($p) } else { $acl = [IO.File]::GetAccessControl($p) }
if ($env:ENV_SYNC_NEW -eq '1') {
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRuleSpecific($rule) }
  $inherit = if ($isDir) { 'ContainerInherit,ObjectInherit' } else { 'None' }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
  $acl.SetOwner($sid)
  if ($isDir) { [IO.Directory]::SetAccessControl($p, $acl) } else { [IO.File]::SetAccessControl($p, $acl) }
}
if ($isDir) { $acl = [IO.Directory]::GetAccessControl($p) } else { $acl = [IO.File]::GetAccessControl($p) }
$rules = @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { exit 1 }
`;

/** Check ownership and restrict access before placing any secret bytes here. */
export function protect(path: string, state: "new" | "existing") {
  const info = lstatSync(path);
  if (!info.isDirectory() && !info.isFile())
    throw new Error("not a private storage object");
  if (process.platform === "win32") {
    const root = process.env.SystemRoot;
    if (!root) throw new Error("missing Windows system directory");
    const ps = join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const result = spawnSync(
      ps,
      ["-NoProfile", "-NonInteractive", "-Command", windowsProtection],
      {
        env: {
          ...process.env,
          ENV_SYNC_ITEM: path,
          ENV_SYNC_NEW: state === "new" ? "1" : "0",
        },
        stdio: "ignore",
        windowsHide: true,
        timeout: 15000,
      },
    );
    if (result.status !== 0) throw new Error("private Windows ACL unavailable");
    return;
  }
  const mode = info.isDirectory() ? 0o700 : 0o600;
  if (
    info.uid !== process.getuid?.() ||
    (state === "existing" && (info.mode & 0o777) !== mode)
  )
    throw new Error("not owner-only");
  if (
    process.platform === "darwin" &&
    spawnSync("/bin/chmod", ["-N", path], { stdio: "ignore" }).status !== 0
  )
    throw new Error("cannot remove inherited ACL");
  chmodSync(path, mode);
  if ((lstatSync(path).mode & 0o777) !== mode)
    throw new Error("private mode unavailable");
}

/** Exclusively create, protect, write, flush and close a file within a private directory. */
export function privateWrite(path: string, data: string) {
  const fd = openSync(path, "wx", 0o600);
  try {
    protect(path, "new");
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
