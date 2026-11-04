import fs from "fs";
import path from "path";

/**
 * Resolve Windows PowerShell 5.1 even when the GUI was launched with a
 * sanitized PATH (for example, from another application or a portable build).
 * Keep the normal command name when it is actually present in PATH so existing
 * Windows command resolution and diagnostics remain unchanged.
 */
export function windowsPowerShellExecutable(): string {
  if (process.platform !== "win32") return "powershell.exe";

  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (pathEntries.some((entry) => {
    try { return fs.existsSync(path.join(entry, "powershell.exe")); } catch { return false; }
  })) return "powershell.exe";

  const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!windowsRoot) return "powershell.exe";
  const systemDirectory = process.arch === "ia32" && fs.existsSync(path.join(windowsRoot, "Sysnative"))
    ? "Sysnative"
    : "System32";
  return path.join(windowsRoot, systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
}
