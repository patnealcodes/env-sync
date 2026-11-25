import { isAbsolute } from "node:path";
import { parse } from "./dotenv.js";
import { snapshot } from "./workflow.js";

/** Read only known options from cwd/.env; never export or evaluate its contents. */
export function loadSettings() {
  try {
    const local = snapshot(".env");
    if (!local.ok) return local;
    const parsed = parse(local.text ?? "", "Local file");
    if (!parsed.ok) return parsed;
    const value = (key: string) => {
      const raw = parsed.tokens.get(key)?.raw;
      return (
        process.env[key] ??
        (raw !== undefined && /^['"`]/.test(raw) ? raw.slice(1, -1) : raw)
      );
    };
    const json = value("ENV_SYNC_JSON") ?? "false";
    const skip = value("ENV_SYNC_NO_BACKUP") ?? "false";
    const help = value("ENV_SYNC_HELP") ?? "false";
    const invalid = (message: string) =>
      ({
        ok: false,
        code: "INVALID_ENV",
        message,
        json: json === "true",
      }) as const;
    for (const [key, v] of Object.entries({
      ENV_SYNC_JSON: json,
      ENV_SYNC_NO_BACKUP: skip,
      ENV_SYNC_HELP: help,
    })) {
      if (v !== "true" && v !== "false")
        return invalid(`Set ${key} to true or false before syncing.`);
    }
    const backupDir = value("ENV_SYNC_BACKUP_DIR") || undefined;
    if (backupDir && !isAbsolute(backupDir))
      return invalid(
        "Set ENV_SYNC_BACKUP_DIR to an absolute private directory outside Git, or leave it blank.",
      );
    return {
      ok: true,
      json: json === "true",
      skipBackup: skip === "true",
      help: help === "true",
      backupDir,
    } as const;
  } catch {
    return {
      ok: false,
      code: "IO",
      message:
        "Could not read project settings. Check permissions on .env in the working directory.",
    } as const;
  }
}
