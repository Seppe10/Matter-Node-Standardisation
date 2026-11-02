import { readFile } from "node:fs/promises";
import { expandHomePath } from "@iotedu/contracts/paths";

/** Settings that hold a file or folder path. A leading ~ in these is expanded to the home folder. */
const PATH_SETTING = /(_PATH|_DIR|_ARCHIVE|_ACTIVATE)$/;

export async function loadEnvFile(file: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (process.env[key] == null) process.env[key] = PATH_SETTING.test(key) ? expandHomePath(value.trim()) : value;
  }
}
