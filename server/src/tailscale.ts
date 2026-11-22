// Tailscale status from tailscaled's local API over its unix socket.
// The socket is optional (see docker-compose.yml); without it we only know
// whether the tailscale0 interface exists and the configured TAILSCALE_IP.
import fs from "node:fs";
import http from "node:http";
import { latest } from "./collectors/scheduler.js";
import { demo } from "./demo.js";
import type { TailscaleStatus } from "./protocol.js";

const socket = process.env.TAILSCALE_SOCKET ?? "/var/run/tailscale/tailscaled.sock";

function localApi(p: string): Promise<any> {
  return new Promise((resolve, reject) => {
    // Only ever GET: the local API can also change settings, we never do.
    const req = http.request({ socketPath: socket, path: p, method: "GET", headers: { Host: "local-tailscaled.sock" }, timeout: 4000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`tailscaled ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("tailscaled timed out")));
    req.on("error", reject);
    req.end();
  });
}

const host = (p: any) => (p.HostName || String(p.DNSName ?? "").split(".")[0] || "?");

let cache: { t: number; v: TailscaleStatus } | null = null;
export async function tailscaleStatus(): Promise<TailscaleStatus> {
  if (cache && Date.now() - cache.t < 10_000) return cache.v;
  const fallback: TailscaleStatus = {
    available: false, online: !!latest?.tailscale?.online, peers: [], health: [],
    self: process.env.TAILSCALE_IP ? { name: "", dnsName: "", ips: [process.env.TAILSCALE_IP], os: "", exitNode: false } : undefined,
  };
  if (demo) return demoStatus();
  let v = fallback;
  if (fs.existsSync(socket)) {
    try {
      const s = await localApi("/localapi/v0/status");
      v = {
        available: true,
        online: s.BackendState === "Running" && s.Self?.Online !== false,
        backendState: s.BackendState,
        tailnet: s.CurrentTailnet?.Name,
        magicDNSSuffix: s.CurrentTailnet?.MagicDNSSuffix ?? s.MagicDNSSuffix,
        version: s.Version,
        keyExpiry: s.Self?.KeyExpiry,
        self: s.Self && { name: host(s.Self), dnsName: String(s.Self.DNSName ?? "").replace(/\.$/, ""), ips: s.Self.TailscaleIPs ?? s.TailscaleIPs ?? [], os: s.Self.OS ?? "", exitNode: false },
        peers: Object.values<any>(s.Peer ?? {}).map((p) => ({
          name: host(p), dnsName: String(p.DNSName ?? "").replace(/\.$/, ""), ips: p.TailscaleIPs ?? [], os: p.OS ?? "",
          online: !!p.Online, lastSeen: p.LastSeen, exitNode: !!p.ExitNode, exitNodeOption: !!p.ExitNodeOption,
        })).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
        health: s.Health ?? [],
      };
    } catch (e) { v = { ...fallback, health: [`Couldn't read tailscaled: ${(e as Error).message}`] }; }
  }
  cache = { t: Date.now(), v };
  return v;
}

function demoStatus(): TailscaleStatus {
  const peer = (name: string, ip: string, os: string, online: boolean, extra = {}) =>
    ({ name, dnsName: `${name}.tail1234.ts.net`, ips: [ip], os, online, lastSeen: online ? undefined : new Date(Date.now() - 3 * 3600e3).toISOString(), exitNode: false, exitNodeOption: false, ...extra });
  return {
    available: true, online: true, backendState: "Running", tailnet: "example.github", magicDNSSuffix: "tail1234.ts.net", version: "1.90.0", health: [],
    self: { name: "harbor", dnsName: "harbor.tail1234.ts.net", ips: ["100.64.0.7"], os: "linux", exitNode: false },
    peers: [peer("macbook", "100.64.0.12", "macOS", true), peer("pixel", "100.64.0.21", "android", true), peer("wall-tablet", "100.64.0.30", "android", false)],
  };
}
