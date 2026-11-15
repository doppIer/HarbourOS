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
  stripFrameHeaders?: boolean; // show apps that forbid iframes through HarbourOS's frame proxy
  framePort?: number;           // the proxy port given to this app (set by the server)
  openMode?: "embed" | "tab";   // "tab": the app refuses iframes, open it in a new browser tab
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
  lastMem?: number;           // RAM/CPU last seen while running (for savings)
  lastCpu?: number;
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

export interface StoreApp {
  id: string;                 // folder name in the catalog repo, e.g. "Immich"
  name: string;               // compose project name it ships with
  title: string;
  tagline: string;
  description: string;
  category: string;
  author: string;
  icon: string;
  main: string;               // main service
  image: string;              // main service image
  services: number;
  memMB?: number;             // catalog's memory reservation, summed
  arch: string[];
  webPort?: number;           // published port of the web UI
  index: string;
  scheme: "http" | "https";
  ports: { service: string; target: number; published?: number; protocol: string; description: string }[];
  envs: { service: string; name: string; description: string }[];
  tips?: string;
  pulls?: number;             // Docker Hub pull count of the main image
}

export interface StoreInstall { project: string; app: string; appId: string; created: number; dataRoot: string; ports: number[] }

export interface StoreJob { project: string; app: string; op: "install" | "uninstall"; phase: "running" | "done" | "error"; line?: string }

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
  | { t: "widgets"; changed: string[] }
  | { t: "store"; d: StoreJob }
  | { t: "nowplaying"; d: NowPlaying | null };

/** Music on the server's speaker (AirPlay / Spotify Connect), see nowplaying.ts. */
export interface NowPlaying {
  source: "airplay" | "spotify";
  state: "playing" | "paused" | "stopped";
  title: string; artist: string; album: string;
  cover: string | null;      // URL the tablet can load
  duration: number;          // ms, 0 when unknown
  position: number;          // ms at `at`
  at: number;                // when `position` was true (epoch ms)
  device?: string;           // who is sending, when known
  controls?: boolean;        // play/pause/next/previous work for this source
}
