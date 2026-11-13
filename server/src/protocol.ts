// Shared types between server and web. Type-only: no runtime code here.

export type AppStatus = "stopped" | "starting" | "running" | "error" | "link";

export interface AppConfig {
  id: string;
  name: string;
  icon: string;               // solar:<name> | url | /icons/uploaded.png
  url: string;
  containers: string[];       // container names
  composeProject?: string;    // or a whole compose stack
  healthUrl?: string;
  startOnDemand: boolean;
  idleStopMinutes: number;    // 0 = never
  alwaysOn: boolean;
  startOnBoot: boolean;
  pinned: boolean;
  order: number;
  section: string;            // sidebar section, e.g. "Apps"
  stripFrameHeaders?: boolean;
}

export interface ContainerInfo {
  id: string;
  name: string;
  stack?: string;
  image: string;
  state: string;              // running | exited | restarting | ...
  health?: string;            // healthy | unhealthy | starting
  startedAt?: string;
  restartCount: number;
  cpu?: number;               // %
  mem?: number;               // bytes
  idleSince?: number;         // epoch ms, cpu ~0 since
}

export interface Stats {
  t: number;
  cpu: { total: number; cores: number[]; temp?: number; load: [number, number, number] };
  mem: { used: number; total: number; swapUsed: number; swapTotal: number; cached: number };
  uptime: number;
  net: { rx: number; tx: number; rxToday: number; txToday: number };
  disks: { mount: string; used: number; total: number }[];
  diskIo: { read: number; write: number };
  power: { watts: number; kwhToday: number; monthlyCost: number; source: "rapl" | "plug" | "baseline"; currency: string; pricePerKwh: number };
  tailscale?: { online: boolean; ip?: string };
}

export interface BootEvent { app: string; phase: "starting" | "waiting" | "ready" | "error"; line?: string; elapsed: number }

// client -> server
export type ClientMsg =
  | { t: "sub"; topics: string[] }
  | { t: "unsub"; topics: string[] }
  | { t: "visibility"; visible: boolean }
  | { t: "viewing"; app: string | null };

// server -> client
export type ServerMsg =
  | { t: "stats"; d: Stats }
  | { t: "containers"; d: ContainerInfo[] }
  | { t: "apps"; d: (AppConfig & { status: AppStatus })[] }
  | { t: "boot"; d: BootEvent }
  | { t: "log"; id: string; line: string }
  | { t: "widgets"; changed: string[] };
