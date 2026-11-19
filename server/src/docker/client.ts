// Minimal Docker Engine API client over docker-socket-proxy (plain HTTP).
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import type { ContainerInfo } from "../protocol.js";

const base = env.dockerHost.replace(/^tcp:/, "http:").replace(/\/$/, "");

async function api(p: string, init?: RequestInit) {
  const r = await fetch(base + p, { ...init, signal: init?.signal ?? AbortSignal.timeout(60_000) });
  if (!r.ok && r.status !== 304) throw new Error(`docker ${init?.method ?? "GET"} ${p}: ${r.status} ${await r.text()}`);
  return r;
}

export interface RawContainer {
  Id: string; Names: string[]; Image: string; State: string; Status: string;
  Labels: Record<string, string>;
  Ports?: { IP?: string; PublicPort?: number; PrivatePort: number; Type: string }[];
  NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
}

export const docker = {
  async list(): Promise<RawContainer[]> { return (await api("/containers/json?all=1")).json() as any; },
  async inspect(id: string): Promise<any> { return (await api(`/containers/${encodeURIComponent(id)}/json`)).json(); },
  async start(id: string) { await api(`/containers/${encodeURIComponent(id)}/start`, { method: "POST" }); },
  async stop(id: string) { await api(`/containers/${encodeURIComponent(id)}/stop?t=15`, { method: "POST" }); },
  async restart(id: string) { await api(`/containers/${encodeURIComponent(id)}/restart?t=15`, { method: "POST" }); },
  /** Delete a container (stopping it first). Named volumes and images stay. */
  async remove(id: string) { await api(`/containers/${encodeURIComponent(id)}?force=1&v=0`, { method: "DELETE" }); },

  /** Stream demultiplexed log lines until `signal` aborts. */
  async logs(id: string, onLine: (l: string) => void, signal: AbortSignal, tail = 200, follow = true) {
    const r = await fetch(`${base}/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=0&tail=${tail}&follow=${follow ? 1 : 0}`, { signal });
    if (!r.body) return;
    const tty = (await this.inspect(id)).Config?.Tty;
    let buf = Buffer.alloc(0), text = "";
    const emit = (s: string) => { text += s; let i; while ((i = text.indexOf("\n")) >= 0) { onLine(text.slice(0, i)); text = text.slice(i + 1); } };
    for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
      if (tty) { emit(Buffer.from(chunk).toString("utf8")); continue; }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const len = buf.readUInt32BE(4);
        if (buf.length < 8 + len) break;
        emit(buf.subarray(8, 8 + len).toString("utf8"));
        buf = buf.subarray(8 + len);
      }
    }
    if (text) onLine(text);
  },

  /** Calls `onEvent` for each container event; reconnects forever. */
  async events(onEvent: (e: any) => void) {
    for (;;) {
      try {
        const r = await fetch(`${base}/events?filters=${encodeURIComponent(JSON.stringify({ type: ["container"] }))}`);
        let text = "";
        for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
          text += Buffer.from(chunk).toString("utf8");
          let i; while ((i = text.indexOf("\n")) >= 0) { try { onEvent(JSON.parse(text.slice(0, i))); } catch {} text = text.slice(i + 1); }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 5000));
    }
  },
};

// ---- cheap per-container usage via cgroup v2 (no Docker stats API calls) ----
const cg = (id: string) => [
  path.join(env.hostSys, `fs/cgroup/system.slice/docker-${id}.scope`),
  path.join(env.hostSys, `fs/cgroup/docker/${id}`),
];
const prevCpu = new Map<string, { usec: number; t: number }>();
export function cgroupUsage(id: string): { cpu?: number; mem?: number } {
  for (const dir of cg(id)) {
    try {
      const stat = fs.readFileSync(path.join(dir, "cpu.stat"), "utf8");
      const usec = Number(/usage_usec (\d+)/.exec(stat)?.[1] ?? 0);
      const memCur = Number(fs.readFileSync(path.join(dir, "memory.current"), "utf8"));
      const t = Date.now();
      const p = prevCpu.get(id);
      prevCpu.set(id, { usec, t });
      const cpu = p ? ((usec - p.usec) / ((t - p.t) * 1000)) * 100 : undefined;
      return { cpu, mem: memCur };
    } catch {}
  }
  return {};
}

export function toInfo(c: RawContainer, extra: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: c.Id,
    name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
    stack: c.Labels["com.docker.compose.project"],
    image: c.Image,
    state: c.State,
    health: /\((healthy|unhealthy|health: starting)\)/.exec(c.Status)?.[1]?.replace("health: ", ""),
    restartCount: 0,
    ips: Object.entries(c.NetworkSettings?.Networks ?? {})
      .filter(([, n]) => n.IPAddress).map(([network, n]) => ({ network, ip: n.IPAddress! })),
    // one entry per published port (Docker lists IPv4 and IPv6 bindings separately)
    ports: [...new Map((c.Ports ?? []).filter((p) => p.PublicPort)
      .map((p) => [`${p.PublicPort}/${p.Type}`, { public: p.PublicPort!, private: p.PrivatePort, type: p.Type, ip: p.IP }])).values()]
      .sort((a, b) => a.public - b.public),
    ...extra,
  };
}
