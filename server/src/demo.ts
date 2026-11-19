// HARBOR_DEMO=1: simulated host and containers, for screenshots and UI work
// on a machine without Docker or /proc. Never enable it on the real server.
import type { ContainerInfo, Stats } from "./protocol.js";
import type { RawContainer } from "./docker/client.js";

export const demo = process.env.HARBOR_DEMO === "1";

const GB = 2 ** 30, MB = 2 ** 20;
let t = 0;
const wave = (period: number, phase = 0) => Math.sin((t / period) * Math.PI * 2 + phase);
const noise = (a: number) => (Math.random() - 0.5) * a;
let kwh = 1.84, rxToday = 4.1 * GB, txToday = 0.62 * GB;

export function demoStats(): Stats {
  t++;
  const cpu = Math.max(2, 9 + 6 * wave(90) + 10 * Math.max(0, wave(37, 1)) ** 4 + noise(3));
  const watts = 24 + cpu * 0.42 + noise(1.5);
  const rx = Math.max(0, 900e3 + 700e3 * wave(60, 2) + noise(300e3));
  const tx = Math.max(0, 120e3 + 80e3 * wave(45) + noise(40e3));
  kwh += (watts * 2) / 3600 / 1000; rxToday += rx * 2; txToday += tx * 2;
  return {
    t: Date.now(),
    cpu: { total: cpu, cores: [0, 1, 2, 3].map((i) => Math.max(0, cpu + noise(8) + i)), temp: 44 + cpu * 0.35 + noise(1), load: [0.38 + cpu / 40, 0.41, 0.36] },
    mem: { total: 16 * GB, used: (9.6 + 0.3 * wave(120)) * GB, cached: 3.1 * GB, swapTotal: 4 * GB, swapUsed: 0.2 * GB },
    uptime: 23 * 86400 + 4 * 3600 + t * 2,
    net: { rx, tx, rxToday, txToday },
    disks: [{ mount: "/", total: 476 * GB, used: 371 * GB }, { mount: "/mnt/data", total: 3.6 * 1024 * GB, used: 1.9 * 1024 * GB }],
    diskIo: { read: Math.max(0, 2.1e6 + noise(1.5e6)), write: Math.max(0, 0.4e6 + noise(0.3e6)) },
    power: { watts, kwhToday: kwh, monthlyCost: 0.74 * 30 * 0.3, source: "rapl", currency: "€", pricePerKwh: 0.3 },
    tailscale: { online: true, ip: "100.64.0.7" },
  };
}

// name, stack, mem MB, cpu %, state, extra
const DEF: [string, string | undefined, number, number, string, Partial<ContainerInfo>?][] = [
  ["homeassistant", undefined, 412, 1.8, "running"],
  ["navidrome", undefined, 92, 0.4, "running"],
  ["jellyfin", undefined, 0, 0, "exited", { lastMem: 1.4 * GB, lastCpu: 2.5 }],
  ["obsidian", undefined, 0, 0, "exited", { lastMem: 610 * MB, lastCpu: 0.8 }],
  ["langfuse-web", "langfuse", 610, 0.2, "running", { idleSince: Date.now() - 3.2 * 86400e3 }],
  ["langfuse-worker", "langfuse", 380, 0.1, "running", { idleSince: Date.now() - 3.2 * 86400e3 }],
  ["langfuse-postgres", "langfuse", 240, 0.1, "running"],
  ["langfuse-clickhouse", "langfuse", 520, 0.6, "running"],
  ["langfuse-redis", "langfuse", 18, 0.1, "running"],
  ["langfuse-minio", "langfuse", 96, 0.0, "running"],
  ["langfuse-otel", "langfuse", 44, 0.0, "running"],
  ["shrink-it", "shrink-it", 120, 0.3, "running"],
  ["shrink-it-postgres", "shrink-it", 64, 0.1, "running"],
  ["shrink-it-redis", "shrink-it", 12, 0.1, "running"],
  ["snapotter", "snapotter", 0, 0, "restarting", { restartCount: 14 }],
  ["snapotter-postgres", "snapotter", 58, 0.1, "running"],
  ["snapotter-redis", "snapotter", 10, 0.1, "running"],
  ["traefik", undefined, 48, 0.3, "running"],
  ["sablier", undefined, 22, 0.1, "running"],
  ["tailscale", undefined, 36, 0.2, "running"],
  ["telegram-bot", undefined, 54, 0.1, "running"],
  ["vaultwarden", undefined, 38, 0.0, "running"],
  ["paperless", "paperless", 0, 0, "exited", { lastMem: 720 * MB, lastCpu: 0.6 }],
  ["paperless-redis", "paperless", 0, 0, "exited"],
  ["immich-server", "immich", 0, 0, "exited", { lastMem: 900 * MB, lastCpu: 1.2 }],
  ["immich-ml", "immich", 0, 0, "exited", { lastMem: 1.6 * GB, lastCpu: 1.5 }],
  ["uptime-kuma", undefined, 88, 0.4, "running"],
  ["adguard", undefined, 72, 0.3, "running"],
  ["harbor", "harboros", 58, 0.4, "running"],
];

export function demoContainers(): { raw: RawContainer[]; info: ContainerInfo[] } {
  const raw: RawContainer[] = [], info: ContainerInfo[] = [];
  DEF.forEach(([name, stack, mem, cpu, state, extra], i) => {
    const id = `demo${i.toString().padStart(4, "0")}`;
    raw.push({ Id: id, Names: ["/" + name], Image: name + ":latest", State: state, Status: state, Labels: stack ? { "com.docker.compose.project": stack, "com.docker.compose.service": name } : {} });
    info.push({
      id, name, stack, image: name + ":latest", state, restartCount: 0,
      startedAt: state === "running" ? new Date(Date.now() - (2 + i) * 86400e3).toISOString() : undefined,
      cpu: state === "running" ? Math.max(0, cpu + noise(cpu * 0.6)) : undefined,
      mem: state === "running" ? mem * MB * (1 + noise(0.04)) : undefined,
      health: state === "running" && i % 5 === 0 ? "healthy" : undefined,
      ips: state === "running" ? [{ network: (stack ?? "bridge") + (stack ? "_default" : ""), ip: `172.18.0.${i + 2}` }] : [],
      ports: state === "running" && i % 3 === 0 ? [{ public: 8000 + i, private: 80, type: "tcp", ip: "0.0.0.0" }] : [],
      ...extra,
    });
  });
  return { raw, info };
}
