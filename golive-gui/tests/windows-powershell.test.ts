import { describe, expect, it } from "vitest";
import { resolveWindowsPowerShellExecutable } from "../electron/windows-powershell";

describe("localização do PowerShell no Windows", () => {
  it("prefere o executável existente no PATH", () => {
    const result = resolveWindowsPowerShellExecutable({
      platform: "win32",
      arch: "x64",
      pathValue: "C:\\Tools;C:\\Windows\\System32",
      windowsRoot: "C:\\Windows",
      existsSync: (file) => file === "C:\\Tools\\powershell.exe",
    });

    expect(result).toBe("C:\\Tools\\powershell.exe");
  });

  it("usa a cópia SysWOW64 quando a cópia System32 não existe", () => {
    const result = resolveWindowsPowerShellExecutable({
      platform: "win32",
      arch: "x64",
      windowsRoot: "C:\\Windows",
      existsSync: (file) => file === "C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe",
    });

    expect(result).toBe("C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("usa PowerShell 7 se Windows PowerShell não estiver instalado", () => {
    const result = resolveWindowsPowerShellExecutable({
      platform: "win32",
      arch: "x64",
      windowsRoot: "C:\\Windows",
      programFiles: "C:\\Program Files",
      existsSync: (file) => file === "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    });

    expect(result).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  });

  it("não retorna um caminho presumido quando nenhum executável existe", () => {
    expect(() => resolveWindowsPowerShellExecutable({
      platform: "win32",
      arch: "x64",
      windowsRoot: "C:\\Windows",
      existsSync: () => false,
    })).toThrowError(expect.objectContaining({ code: "WINDOWS_POWERSHELL_NOT_FOUND" }));
  });

  it("não exige PowerShell fora do Windows", () => {
    expect(resolveWindowsPowerShellExecutable({ platform: "linux", arch: "x64" })).toBe("powershell.exe");
  });
});
