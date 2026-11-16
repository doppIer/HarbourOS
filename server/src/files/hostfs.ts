// File access for the Files app. With TERMINAL_MODE=ssh every operation runs
// on the host as the terminal user, so HarbourOS can only read or change what
// that user can (no root, no container-only view). Locally it uses this
// machine's filesystem under FILES_ROOT (handy for development and demo).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { env } from "../env.js";
import { hostExec, hostSpawn, isAuthError, q, SSH_HINT } from "../host.js";

export interface Entry { name: string; type: "dir" | "file" | "link" | "other"; target?: "dir" | "file" | "other"; size: number; mtime: number; mode: string; owner: string }
export interface Stat { type: "dir" | "file" | "other"; size: number; mtime: number }

export const httpError = (status: number, msg: string) => Object.assign(new Error(msg), { statusCode: status });

/** Absolute, normalised host path. Rejects anything odd. */
export function clean(p: unknown): string {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0") || p.length > 4096) throw httpError(400, "Use an absolute path.");
  const n = path.posix.normalize(p);
  return n.length > 1 ? n.replace(/\/+$/, "") : n;
}

/** Deleting these would wreck the host; refuse even if permissions allow it. */
export function protectedPath(p: string) {
  return p.split("/").filter(Boolean).length < 2 || /^\/(proc|sys|dev|boot)(\/|$)/.test(p);
}

const MAX_ENTRIES = 5000;
const ssh = env.terminalMode === "ssh";
const root = path.resolve(env.filesRoot);
let realRoot = root;
try { realRoot = fs.realpathSync(root); } catch {}
/** A path under the files root. Symlinks inside the root may not lead outside it. */
const local = (p: string) => {
  const full = path.join(root, p);
  let probe = full;
  while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
  let real = probe;
  try { real = fs.realpathSync(probe); } catch {}
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw httpError(403, `${p} leads outside the files folder.`);
  return full;
};

function sshError(err: string, p: string): Error {
  if (isAuthError(err)) return httpError(503, SSH_HINT);
  if (/permission denied/i.test(err)) return httpError(403, `Permission denied for ${p}. HarbourOS works as the terminal user on the host.`);
  if (/no such file|cannot stat|cannot access/i.test(err)) return httpError(404, `${p} doesn't exist.`);
  if (/exists/i.test(err)) return httpError(409, "Something with that name already exists.");
  if (/not a directory/i.test(err)) return httpError(400, `${p} is not a folder.`);
  return httpError(500, err || "Command failed on the host.");
}
function localError(e: any, p: string): Error {
  if (e?.code === "EACCES" || e?.code === "EPERM") return httpError(403, `Permission denied for ${p}.`);
  if (e?.code === "ENOENT") return httpError(404, `${p} doesn't exist.`);
  if (e?.code === "EEXIST") return httpError(409, "Something with that name already exists.");
  if (e?.code === "ENOTDIR") return httpError(400, `${p} is not a folder.`);
  return e;
}
async function run(script: string, p: string, stdin?: Buffer) {
  const r = await hostExec(script, stdin);
  if (r.code !== 0) throw sshError(r.err, p);
  return r.out;
}

const kind = (c: string): Entry["type"] => (c === "d" ? "dir" : c === "f" ? "file" : c === "l" ? "link" : "other");
const statKind = (s: fs.Stats): Stat["type"] => (s.isDirectory() ? "dir" : s.isFile() ? "file" : "other");

export const hostfs = {
  /** The terminal user's home folder ("/" when running locally). */
  async home(): Promise<string> {
    if (!ssh) return process.env.FILES_HOME ?? "/";
    const r = await hostExec('printf %s "$HOME"');
    if (r.code !== 0 && isAuthError(r.err)) throw httpError(503, SSH_HINT);
    return r.code === 0 && r.out.length ? r.out.toString() : "/";
  },

  async list(dir: string): Promise<Entry[]> {
    if (ssh) {
      const out = await run(`cd -- ${q(dir)} && find . -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%Y\\t%s\\t%T@\\t%m\\t%u\\0' | head -z -n ${MAX_ENTRIES}`, dir);
      return out.toString("utf8").split("\0").filter(Boolean).map((l) => {
        const [name, y, Y, size, t, mode, owner] = l.split("\t");
        const type = kind(y);
        return { name, type, ...(type === "link" ? { target: kind(Y) as Entry["target"] } : {}), size: Number(size), mtime: Math.round(Number(t) * 1000), mode, owner };
      });
    }
    try {
      const names = (await fsp.readdir(local(dir))).slice(0, MAX_ENTRIES);
      return Promise.all(names.map(async (name) => {
        const full = path.join(local(dir), name);
        const l = await fsp.lstat(full);
        const type: Entry["type"] = l.isSymbolicLink() ? "link" : l.isDirectory() ? "dir" : l.isFile() ? "file" : "other";
        let target: Entry["target"];
        if (type === "link") target = await fsp.stat(full).then(statKind, () => "other" as const);
        return { name, type, target, size: l.size, mtime: Math.round(l.mtimeMs), mode: (l.mode & 0o7777).toString(8), owner: String(l.uid) };
      }));
    } catch (e) { throw localError(e, dir); }
  },

  async stat(p: string): Promise<Stat> {
    if (ssh) {
      const [t, size, mtime] = (await run(`stat -L -c '%F\\t%s\\t%.3Y' -- ${q(p)}`, p)).toString().trim().split("\t");
      return { type: t === "directory" ? "dir" : t.includes("regular") ? "file" : "other", size: Number(size), mtime: Math.round(Number(mtime) * 1000) };
    }
    try { const s = await fsp.stat(local(p)); return { type: statKind(s), size: s.size, mtime: Math.round(s.mtimeMs) }; }
    catch (e) { throw localError(e, p); }
  },

  async read(p: string, max: number): Promise<Buffer> {
    if (ssh) return run(`head -c ${max} -- ${q(p)}`, p);
    try { const fh = await fsp.open(local(p)); try { const b = Buffer.alloc(max); const { bytesRead } = await fh.read(b, 0, max, 0); return b.subarray(0, bytesRead); } finally { await fh.close(); } }
    catch (e) { throw localError(e, p); }
  },

  /** Overwrites in place, so the file keeps its owner and permissions. */
  async write(p: string, data: Buffer) {
    if (ssh) { await run(`cat > ${q(p)}`, p, data); return; }
    try { await fsp.writeFile(local(p), data); } catch (e) { throw localError(e, p); }
  },

  stream(p: string): Readable {
    if (ssh) { const c = hostSpawn(`cat -- ${q(p)}`); c.stdin.end(); return c.stdout; }
    return fs.createReadStream(local(p));
  },

  async mkdir(p: string) {
    if (ssh) { await run(`mkdir -- ${q(p)}`, p); return; }
    try { await fsp.mkdir(local(p)); } catch (e) { throw localError(e, p); }
  },

  async rename(from: string, to: string) {
    if (ssh) { await run(`if [ -e ${q(to)} ]; then echo "exists" >&2; exit 4; fi; mv -- ${q(from)} ${q(to)}`, from); return; }
    try {
      if (fs.existsSync(local(to))) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      await fsp.rename(local(from), local(to));
    } catch (e) { throw localError(e, from); }
  },

  async remove(p: string) {
    if (protectedPath(p)) throw httpError(400, `HarbourOS won't delete ${p}.`);
    if (ssh) { await run(`rm -rf -- ${q(p)}`, p); return; }
    try { await fsp.rm(local(p), { recursive: true }); } catch (e) { throw localError(e, p); }
  },
};
