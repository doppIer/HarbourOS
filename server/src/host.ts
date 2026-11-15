// Running shell commands on the host. In Docker that's SSH to the host as the
// terminal user (TERMINAL_MODE=ssh); in local development it's this machine.
// SSH reuses one connection (ControlMaster) so short commands stay fast.
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";

/** Shown whenever the host refuses our key. */
export const SSH_HINT = "HarbourOS can't sign in to the host over SSH. On the server, in the HarbourOS folder, run: sudo bash host/setup-terminal.sh";
export const isAuthError = (err: string) => /permission denied \((publickey|password)|identity file .* not accessible|host key verification failed|connection refused|could not resolve hostname/i.test(err);

/** Make sure the container has a key pair, so setup-terminal.sh only has to authorise it. */
export function ensureSshKey() {
  if (env.terminalMode !== "ssh" || fs.existsSync(env.sshKey)) return;
  try {
    fs.mkdirSync(path.dirname(env.sshKey), { recursive: true, mode: 0o700 });
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "harboros", "-f", env.sshKey], { stdio: "ignore" });
    console.log(`Created ${env.sshKey}. Authorise it on the host: sudo bash host/setup-terminal.sh`);
  } catch (e) { console.warn("Could not create an SSH key:", (e as Error).message); }
}

export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Start `script` under bash on the host. stdin is left open for the caller. */
export function hostSpawn(script: string): ChildProcessWithoutNullStreams {
  if (env.terminalMode === "ssh") {
    return spawn("ssh", [
      "-i", env.sshKey, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR", "-o", "StrictHostKeyChecking=accept-new",
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
