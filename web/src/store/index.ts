import { signal, computed } from "@preact/signals";
import type { AppConfig, AppStatus, BootEvent, ContainerInfo, Stats } from "../../../server/src/protocol";
import { live, api } from "../lib/ws";

export type App = AppConfig & { status: AppStatus };
export interface Settings {
  assistant?: { brain: "rules" | "ollama" | "claude" | "session"; router: "rules" | "model"; ollamaUrl: string; ollamaModel: string; routerModel: string; session: string; wakeWord: string;
    voice?: { engine: "local" | "piper" | "kokoro" | "elevenlabs" | "browser"; piperEn: string; kokoro: string; elevenVoice: string; elevenModel: string; elevenKey?: string } };
  hasElevenKey?: boolean;
  music?: { navidromeUrl: string; navidromeUser: string; navidromePass?: string };
  hasMusicPass?: boolean;
  accent: string; pricePerKwh: number; currency: string; baselineWatts: number;
  plugEntity?: string; haUrl?: string; hasHaToken: boolean;
  background: { module: string; dim: number; blur: number; pauseHidden: boolean; pauseWhenApp: boolean };
  unmountAfterMinutes: number; sidebarCollapsed: boolean;
  allowSignup: boolean; loginBackground: { module: string; dim: number; blur: number };
}

export interface Me { id: string; email: string; name: string; role: "admin" | "member" | "device"; status: string; created: number }
export const me = signal<Me | null>(null);
export const isAdmin = computed(() => me.value?.role === "admin");

export const stats = signal<Stats | null>(null);
export const containers = signal<ContainerInfo[]>([]);
export const apps = signal<App[]>([]);
export const boots = signal<Record<string, BootEvent & { lines: string[] }>>({});
export const settings = signal<Settings | null>(null);

/** "home" | "terminal" | "ai" | "store" | "settings" | app id */
export const view = signal<string>(location.hash.slice(1) || "home");
export const sidebarOpen = signal(false); // mobile drawer
export const dialog = signal<null | { kind: "discover" } | { kind: "add-app"; app?: App } | { kind: "logs"; container: string }>(null);

export const currentApp = computed(() => apps.value.find((a) => a.id === view.value) ?? null);

// Rolling history for charts (fed by the live channel, capped).
export const history = { cpu: [] as number[], mem: [] as number[], rx: [] as number[], tx: [] as number[], watts: [] as number[], temp: [] as number[] };
const CAP = 900; // 30 min at 2 s
const push = (a: number[], v: number) => { a.push(v); if (a.length > CAP) a.shift(); };

live.on((m) => {
  if (m.t === "stats") {
    stats.value = m.d;
    push(history.cpu, m.d.cpu.total);
    push(history.mem, (m.d.mem.used / m.d.mem.total) * 100);
    push(history.rx, m.d.net.rx);
    push(history.tx, m.d.net.tx);
    push(history.watts, m.d.power.watts);
    if (m.d.cpu.temp != null) push(history.temp, m.d.cpu.temp);
  } else if (m.t === "containers") containers.value = m.d;
  else if (m.t === "apps") apps.value = m.d;
  else if (m.t === "boot") {
    const prev = boots.value[m.d.app];
    const lines = m.d.phase === "starting" && !prev ? [] : [...(prev?.lines ?? [])];
    if (m.d.line && lines[lines.length - 1] !== m.d.line) lines.push(m.d.line);
    boots.value = { ...boots.value, [m.d.app]: { ...m.d, lines: lines.slice(-30) } };
  }
});

export function navigate(v: string) {
  const tab = apps.value.find((a) => a.id === v && a.openMode === "tab");
  if (tab) { // the app refuses iframes: start it if needed and open it next to HarborOS
    window.open(tab.url, "_blank", "noopener");
    if (tab.status !== "running" && tab.status !== "link") fetch(`/api/apps/${tab.id}/open`, { method: "POST" }).catch(() => {});
    sidebarOpen.value = false;
    return;
  }
  view.value = v;
  location.hash = v === "home" ? "" : v;
  sidebarOpen.value = false;
  const app = apps.value.find((a) => a.id === v);
  live.setViewing(app ? app.id : null);
}
window.addEventListener("hashchange", () => { const v = location.hash.slice(1) || "home"; if (v !== view.value) navigate(v); });

export async function loadSettings() { settings.value = await api<Settings>("/api/settings"); applyAccent(); }
export async function saveSettings(patch: Partial<Settings>) {
  settings.value = await api<Settings>("/api/settings", { method: "PUT", json: patch }); applyAccent();
}
function applyAccent() { if (settings.value) document.documentElement.style.setProperty("--acc", settings.value.accent); }
