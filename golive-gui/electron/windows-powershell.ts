import { execFile } from "child_process";
import crypto from "crypto";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import * as logger from "./logger";

type WindowsPowerShellResolverOptions = {
  platform: string;
  arch: string;
  pathValue?: string;
  windowsRoot?: string;
  programFiles?: string;
  programFilesX86?: string;
  bundledRuntimePath?: string;
  existsSync?: (file: string) => boolean;
};

const PORTABLE_POWERSHELL_VERSION = "7.6.9";
const PORTABLE_POWERSHELL_RELEASE = `https://github.com/PowerShell/PowerShell/releases/download/v${PORTABLE_POWERSHELL_VERSION}`;
const PORTABLE_POWERSHELL_ASSETS: Record<string, { name: string; sha256: string }> = {
  x64: {
    name: `PowerShell-${PORTABLE_POWERSHELL_VERSION}-win-x64.zip`,
    sha256: "CE7484804C0F0AD4DDA10C958E71ACDAF7EEBFB22505C1B480F89E0E9F1DA94D",
  },
  ia32: {
    name: `PowerShell-${PORTABLE_POWERSHELL_VERSION}-win-x86.zip`,
    sha256: "5B9806943EE5F1CF4AFD1E04AF859D7445449F017550D7E3EAC3B86B3E80A7CE",
  },
  arm64: {
    name: `PowerShell-${PORTABLE_POWERSHELL_VERSION}-win-arm64.zip`,
    sha256: "2157FB002178E606C2A5532C56647118D90D029742F04D4900A71E3B478C2363",
  },
};
const MAX_PORTABLE_POWERSHELL_BYTES = 250 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export function resolveWindowsPowerShellExecutable(options: WindowsPowerShellResolverOptions): string {
  if (options.platform !== "win32") return "powershell.exe";

  const exists = options.existsSync ?? fs.existsSync;
  const winPath = path.win32;
  const pathEntries = (options.pathValue || "").split(";").filter(Boolean);
  const candidates: string[] = [];

  // Prefer Windows PowerShell when both engines are installed. Some stripped
  // Windows images keep only the 32-bit copy under SysWOW64.
  for (const entry of pathEntries) candidates.push(winPath.join(entry, "powershell.exe"));

  const windowsRoot = options.windowsRoot;
  if (windowsRoot) {
    if (options.arch === "ia32") candidates.push(winPath.join(windowsRoot, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"));
    candidates.push(winPath.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
    candidates.push(winPath.join(windowsRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"));
  }

  for (const entry of [options.programFiles, options.programFilesX86].filter((value): value is string => Boolean(value))) {
    candidates.push(winPath.join(entry, "PowerShell", "7", "pwsh.exe"));
  }
  for (const entry of pathEntries) candidates.push(winPath.join(entry, "pwsh.exe"));
  if (options.bundledRuntimePath) candidates.push(options.bundledRuntimePath);

  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // Continue through known installation locations.
    }
  }

  const searched = candidates.length ? candidates.join("; ") : "nenhum caminho Windows conhecido";
  throw Object.assign(new Error(`PowerShell não encontrado. Caminhos verificados: ${searched}`), {
    code: "WINDOWS_POWERSHELL_NOT_FOUND",
  });
}

function portableRuntimePaths(): { directory: string; executable: string } {
  const localAppData = process.env.LOCALAPPDATA || path.win32.join(os.homedir(), "AppData", "Local");
  const directory = path.win32.join(localAppData, "GoLiveBypass", "runtimes", `powershell-${PORTABLE_POWERSHELL_VERSION}-${process.arch}`);
  return { directory, executable: path.win32.join(directory, "pwsh.exe") };
}

/**
 * Resolve an installed Windows PowerShell or PowerShell 7 runtime. Portable
 * PowerShell is provisioned lazily by ensureWindowsPowerShellExecutable when
 * a stripped Windows image has removed both built-in and user-installed copies.
 */
export function windowsPowerShellExecutable(): string {
  if (process.platform !== "win32") return "powershell.exe";
  const runtime = portableRuntimePaths();
  return resolveWindowsPowerShellExecutable({
    platform: process.platform,
    arch: process.arch,
    pathValue: process.env.PATH,
    windowsRoot: process.env.SystemRoot || process.env.WINDIR,
    programFiles: process.env.ProgramFiles,
    programFilesX86: process.env["ProgramFiles(x86)"],
    bundledRuntimePath: runtime.executable,
  });
}

let provisioning: Promise<string> | null = null;

/**
 * Makes PowerShell available for WireSock activation and recovery. The official
 * portable archive is downloaded only when every system installation is absent,
 * and is checked against the release SHA-256 before extraction.
 */
export async function ensureWindowsPowerShellExecutable(onProgress?: (message: string) => void): Promise<string> {
  if (process.platform !== "win32") return windowsPowerShellExecutable();
  try {
    return windowsPowerShellExecutable();
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "WINDOWS_POWERSHELL_NOT_FOUND") throw error;
  }

  if (provisioning) return provisioning;
  logger.info("wiresock", "runtime PowerShell portátil ausente; iniciando download verificado", {
    version: PORTABLE_POWERSHELL_VERSION,
    architecture: process.arch,
  });
  provisioning = provisionPortablePowerShell(onProgress).then((executable) => {
    logger.info("wiresock", "runtime PowerShell portátil preparado", {
      version: PORTABLE_POWERSHELL_VERSION,
      architecture: process.arch,
    });
    return executable;
  }, (error) => {
    logger.error("wiresock", "falha ao preparar runtime PowerShell portátil", {
      version: PORTABLE_POWERSHELL_VERSION,
      architecture: process.arch,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }).finally(() => { provisioning = null; });
  return provisioning;
}

async function provisionPortablePowerShell(onProgress?: (message: string) => void): Promise<string> {
  const asset = PORTABLE_POWERSHELL_ASSETS[process.arch];
  if (!asset) throw new Error(`Não há runtime PowerShell portátil fixado para arquitetura ${process.arch}.`);

  const runtime = portableRuntimePaths();
  const parent = path.win32.dirname(runtime.directory);
  await fs.promises.mkdir(parent, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.win32.join(parent, `.powershell-${PORTABLE_POWERSHELL_VERSION}-`));
  const archive = path.win32.join(staging, asset.name);
  const extracted = path.win32.join(staging, "runtime");
  try {
    onProgress?.("Baixando PowerShell portátil para concluir a ativação…");
    await fs.promises.mkdir(extracted);
    await downloadOfficialPowerShellArchive(`${PORTABLE_POWERSHELL_RELEASE}/${asset.name}`, archive);
    const digest = await sha256File(archive);
    if (digest.toUpperCase() !== asset.sha256) throw new Error("SHA-256 do runtime PowerShell não corresponde à release oficial.");

    onProgress?.("Preparando o runtime PowerShell…");
    const tar = windowsTarExecutable();
    await execFileChecked(tar, ["-xf", archive, "-C", extracted], {
      cwd: extracted,
      timeout: 180_000,
    });
    const stagedExecutable = path.win32.join(extracted, "pwsh.exe");
    if (!fs.existsSync(stagedExecutable)) throw new Error("O arquivo ZIP oficial do PowerShell não contém pwsh.exe na raiz.");
    const versionOutput = await execFileChecked(stagedExecutable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
      cwd: extracted,
      timeout: 15_000,
    });
    if (!versionOutput.trim().startsWith(PORTABLE_POWERSHELL_VERSION)) {
      throw new Error(`O runtime PowerShell retornou versão inesperada: ${versionOutput.trim().slice(0, 80) || "sem saída"}.`);
    }

    await fs.promises.rm(runtime.directory, { recursive: true, force: true });
    await fs.promises.rename(extracted, runtime.directory);
    return runtime.executable;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Não foi possível preparar o runtime PowerShell portátil: ${detail}`);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function windowsTarExecutable(): string {
  const winPath = path.win32;
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
  const candidates = [
    ...(windowsRoot ? [winPath.join(windowsRoot, "System32", "tar.exe"), winPath.join(windowsRoot, "SysWOW64", "tar.exe")] : []),
    ...(process.env.PATH || "").split(";").filter(Boolean).map((entry) => winPath.join(entry, "tar.exe")),
  ];
  const found = candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  if (!found) throw new Error("tar.exe não foi encontrado; o Windows precisa dele para extrair o runtime verificado.");
  return found;
}

function downloadOfficialPowerShellArchive(url: string, target: string, redirects = 0): Promise<void> {
  if (redirects > MAX_REDIRECTS) return Promise.reject(new Error("Muitos redirecionamentos ao baixar o runtime PowerShell."));
  let parsed: URL;
  try { parsed = new URL(url); } catch { return Promise.reject(new Error("URL inválida para o runtime PowerShell.")); }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !(hostname === "github.com" || hostname.endsWith(".githubusercontent.com"))) {
    return Promise.reject(new Error("O download do runtime PowerShell foi redirecionado para um host não autorizado."));
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let output: fs.WriteStream | undefined;
    let responseStream: import("http").IncomingMessage | undefined;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      output?.destroy();
      responseStream?.destroy();
      reject(error);
    };
    const request = https.get(parsed, {
      headers: { "User-Agent": "GoLiveBypass-PowerShellRuntime", Accept: "application/octet-stream" },
    }, (response) => {
      responseStream = response;
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        void downloadOfficialPowerShellArchive(new URL(response.headers.location, parsed).toString(), target, redirects + 1)
          .then(() => { if (!settled) { settled = true; resolve(); } }, fail);
        return;
      }
      if (status !== 200) {
        response.resume();
        fail(new Error(`Download do runtime PowerShell retornou HTTP ${status || "desconhecido"}.`));
        return;
      }

      let total = 0;
      output = fs.createWriteStream(target, { flags: "wx" });
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_PORTABLE_POWERSHELL_BYTES) {
          response.destroy(new Error("O runtime PowerShell excede o tamanho máximo permitido."));
        }
      });
      response.on("error", fail);
      output.on("error", fail);
      response.pipe(output);
      output.on("finish", () => output?.close((error) => {
        if (error) { fail(error); return; }
        if (!settled) { settled = true; resolve(); }
      }));
    });
    request.setTimeout(180_000, () => request.destroy(new Error("Tempo limite ao baixar o runtime PowerShell.")));
    request.on("error", fail);
  });
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk: Buffer | string) => { digest.update(chunk); });
    input.on("error", reject);
    input.on("end", () => resolve(digest.digest("hex")));
  });
}

function execFileChecked(file: string, args: string[], options: { cwd: string; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options.cwd,
      windowsHide: true,
      timeout: options.timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: "1" },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? "").trim().slice(-1200);
        reject(new Error(`${path.win32.basename(file)} falhou: ${error.message}${detail ? `; ${detail}` : ""}`));
      } else {
        resolve(String(stdout ?? ""));
      }
    });
  });
}
