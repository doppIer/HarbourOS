// xterm.js <-> PTY bridge. Every tab is a tmux session on the HOST (reached
// over SSH from the container), so closing the browser never kills it.
import { spawn as ptySpawn } from "node-pty";
import { execFile } from "node:child_process";
import type { WebSocket } from "ws";
import { env } from "../env.js";
import { q, SSH_HINT } from "../host.js";
import { script } from "./agents.js";

const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "main";
const PREFIX = "harbor-";

function command(tmuxArgs: string[]): [string, string[]] {
  if (env.terminalMode === "ssh") {
    return ["ssh", ["-tt", "-i", env.sshKey, "-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "LogLevel=ERROR",
      "-o", `UserKnownHostsFile=${env.dataDir}/ssh/known_hosts`, env.sshTarget, "--", "tmux", ...tmuxArgs]];
  }
  return ["tmux", tmuxArgs];
}

export function attach(ws: WebSocket, name: string, program?: string) {
  const session = PREFIX + clean(name);
  const args = ["new-session", "-A", "-s", session];
  const run = script(program);
  if (run) args.push(env.terminalMode === "ssh" ? q(run) : run);
  const [cmd, argv] = command(args);
  const pty = ptySpawn(cmd, argv, { name: "xterm-256color", cols: 100, rows: 30, env: { ...process.env, TERM: "xterm-256color" } as any });

  let out = "";
  pty.onData((d) => { if (out.length < 2000) out += d; if (ws.readyState === 1) ws.send(d); });
  pty.onExit(() => {
    if (env.terminalMode === "ssh" && /permission denied|not accessible|connection refused/i.test(out) && ws.readyState === 1) ws.send(`\r\n\x1b[33m${SSH_HINT}\x1b[0m\r\n`);
    if (ws.readyState === 1) ws.close(1000, "session ended"); });
  ws.on("message", (raw, isBinary) => {
    const s = isBinary ? Buffer.from(raw as Buffer).toString("utf8") : String(raw);
    // control frames: "\u0000{json}"
    if (s.charCodeAt(0) === 0) {
      try { const m = JSON.parse(s.slice(1)); if (m.t === "resize") pty.resize(Math.max(2, m.cols | 0), Math.max(2, m.rows | 0)); } catch {}
      return;
    }
    pty.write(s);
  });
  // Detach (not kill) when the socket closes: tmux keeps the session alive.
  ws.on("close", () => { try { pty.kill(); } catch {} });
}

function tmux(args: string[]): Promise<string> {
  const [cmd, argv] = command(args);
  const a = cmd === "ssh" ? argv.filter((x) => x !== "-tt") : argv;
  return new Promise((res) => execFile(cmd, a, { timeout: 8000 }, (_e, out) => res(String(out ?? ""))));
}

export async function listSessions(): Promise<string[]> {
  const out = await tmux(["list-sessions", "-F", "#S"]);
  return out.split("\n").filter((s) => s.startsWith(PREFIX)).map((s) => s.slice(PREFIX.length));
}

export async function killSession(name: string) { await tmux(["kill-session", "-t", PREFIX + clean(name)]); }
