/**
 * OS-protected secret storage.
 *
 * Windows: values are encrypted with DPAPI (ProtectedData, CurrentUser scope).
 * Sara OS/Linux: when MYRAA_SECRET_BACKEND=libsecret, values are stored by the
 * desktop Secret Service (gnome-keyring) and only metadata is written here.
 * Other platforms: owner-only (0600) file, documented as weaker.
 *
 * Decrypted values are cached in this backend process only. They are never
 * sent to a renderer; the UI only learns whether a secret exists.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type SecretProtection = "dpapi" | "libsecret" | "plain-0600";

interface StoredSecret {
  protection: SecretProtection;
  data: string;
  updatedAt: string;
}

interface SecretFile {
  version: 2;
  entries: Record<string, StoredSecret>;
}

export interface SecretCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export type SecretCommandRunner = (command: string, args: string[], input: string) => SecretCommandResult;

export interface SecretStoreOptions {
  /** Explicit backend for tests/OS packaging. Windows always retains DPAPI. */
  backend?: "auto" | "libsecret" | "plain-0600";
  commandRunner?: SecretCommandRunner;
}

const PS_ENCRYPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$plain=[Console]::In.ReadToEnd()",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($plain)",
  "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($protected))",
].join(";");

const PS_DECRYPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Security",
  "$b64=[Console]::In.ReadToEnd().Trim()",
  "$bytes=[Convert]::FromBase64String($b64)",
  "$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($plain))",
].join(";");

const defaultCommandRunner: SecretCommandRunner = (command, args, input) => {
  const result = spawnSync(command, args, {
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error,
  };
};

function commandFailure(label: string, result: SecretCommandResult): Error {
  const detail = result.error?.message
    || String(result.stderr || "").trim().split("\n")[0]
    || `exit ${result.status ?? "unknown"}`;
  return new Error(`${label} failed: ${detail}`);
}

export class SecretStore {
  private readonly file: string;
  private readonly cache = new Map<string, string>();
  private readonly commandRunner: SecretCommandRunner;
  private loaded = false;
  private store: SecretFile = { version: 2, entries: {} };

  constructor(
    private readonly dataDir: string,
    private readonly platform = process.platform,
    private readonly options: SecretStoreOptions = {},
  ) {
    this.file = path.join(dataDir, "secrets.v2.json");
    this.commandRunner = options.commandRunner || defaultCommandRunner;
  }

  get protection(): SecretProtection {
    if (this.platform === "win32") return "dpapi";
    const configured = this.options.backend || process.env.MYRAA_SECRET_BACKEND || "auto";
    if (this.platform === "linux" && configured === "libsecret") return "libsecret";
    return "plain-0600";
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf-8")) as SecretFile;
        if (parsed?.version === 2 && parsed.entries) this.store = parsed;
      }
    } catch {
      this.store = { version: 2, entries: {} };
    }
  }

  has(name: string): boolean {
    this.load();
    return Boolean(this.store.entries[name]);
  }

  get(name: string): string | undefined {
    this.load();
    if (this.cache.has(name)) return this.cache.get(name);
    const entry = this.store.entries[name];
    if (!entry) return undefined;
    try {
      let value: string;
      if (entry.protection === "dpapi") {
        const result = this.commandRunner(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_DECRYPT],
          entry.data,
        );
        if (result.status !== 0) throw commandFailure("DPAPI operation", result);
        value = Buffer.from(String(result.stdout || "").trim(), "base64").toString("utf8");
      } else if (entry.protection === "libsecret") {
        const result = this.commandRunner(
          "secret-tool",
          ["lookup", "application", "sara", "name", name],
          "",
        );
        if (result.status !== 0) throw commandFailure("Secret Service lookup", result);
        value = String(result.stdout || "").replace(/[\r\n]+$/, "");
        if (!value) return undefined;
      } else {
        value = Buffer.from(entry.data, "base64").toString("utf8");
      }
      this.cache.set(name, value);
      return value;
    } catch {
      // Unreadable (copied DPAPI data, locked/missing keyring): treat as absent.
      return undefined;
    }
  }

  set(name: string, value: string): void {
    this.load();
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Secret must not be empty.");
    const protection = this.protection;
    let data: string;
    if (protection === "dpapi") {
      const result = this.commandRunner(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_ENCRYPT],
        trimmed,
      );
      if (result.status !== 0) throw commandFailure("DPAPI operation", result);
      data = String(result.stdout || "").trim();
    } else if (protection === "libsecret") {
      const result = this.commandRunner(
        "secret-tool",
        ["store", "--label=Sara provider credential", "application", "sara", "name", name],
        trimmed,
      );
      if (result.status !== 0) throw commandFailure("Secret Service store", result);
      data = "secret-service";
    } else {
      data = Buffer.from(trimmed, "utf8").toString("base64");
    }
    this.store.entries[name] = { protection, data, updatedAt: new Date().toISOString() };
    this.cache.set(name, trimmed);
    this.save();
  }

  delete(name: string): void {
    this.load();
    const entry = this.store.entries[name];
    if (entry?.protection === "libsecret") {
      const result = this.commandRunner(
        "secret-tool",
        ["clear", "application", "sara", "name", name],
        "",
      );
      if (result.status !== 0) throw commandFailure("Secret Service clear", result);
    }
    delete this.store.entries[name];
    this.cache.delete(name);
    this.save();
  }

  names(): string[] {
    this.load();
    return Object.keys(this.store.entries);
  }

  private save(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.store, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(temp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows relies on DPAPI rather than mode bits */
    }
  }

  /**
   * Move a plaintext key from the legacy secrets.json into protected storage
   * and scrub it from the legacy file. Returns true when a migration happened.
   */
  migrateLegacyPlaintext(legacyFile: string, legacyField: string, name: string): boolean {
    try {
      if (!fs.existsSync(legacyFile)) return false;
      const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf-8")) as Record<string, unknown>;
      const value = typeof legacy[legacyField] === "string" ? String(legacy[legacyField]).trim() : "";
      if (!value) return false;
      if (!this.has(name)) this.set(name, value);
      // Only scrub once the protected copy is verifiably readable.
      if (this.get(name) !== value) return false;
      delete legacy[legacyField];
      fs.writeFileSync(legacyFile, JSON.stringify(legacy, null, 2), "utf-8");
      return true;
    } catch {
      return false;
    }
  }
}
