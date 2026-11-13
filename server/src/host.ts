// Running shell commands on the host. In Docker that's SSH to the host as the
// terminal user (TERMINAL_MODE=ssh); in local development it's this machine.
// SSH reuses one connection (ControlMaster) so short commands stay fast.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { env } from "./env.js";

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Start `script` under bash on the host. stdin is left open for the caller. */
export function hostSpawn(script: string): ChildProcessWithoutNullStreams {
  if (env.terminalMode === "ssh") {
    return spawn("ssh", [
      "-i", env.sshKey, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
      "-o", `UserKnownHostsFile=${env.dataDir}/ssh/known_hosts`,
      "-o", "ControlMaster=auto", "-o", `ControlPath=${env.dataDir}/ssh/cm-%C`, "-o", "ControlPersist=120",
      env.sshTarget, "--", "bash", "-c", q(script),
    ]);
  }
  return spawn("bash", ["-c", script]);
}

/** Run `script`, feeding `stdin`, and collect its output. */
export function hostExec(script: string, stdin?: Buffer | string, maxOut = 64 * 2 ** 20): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve) => {
    const p = hostSpawn(script);
    const chunks: Buffer[] = []; let size = 0; let err = "";
    p.stdout.on("data", (d: Buffer) => { size += d.length; if (size <= maxOut) chunks.push(d); else p.kill(); });
    p.stderr.on("data", (d: Buffer) => { if (err.length < 4000) err += d.toString(); });
    p.on("error", (e) => resolve({ code: 127, out: Buffer.alloc(0), err: e.message }));
    p.on("close", (code) => resolve({ code: code ?? 1, out: Buffer.concat(chunks), err: err.trim() }));
    p.stdin.on("error", () => {});
    p.stdin.end(stdin ?? "");
  });
}
