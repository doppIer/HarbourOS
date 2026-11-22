// Self-update. The running version comes from the HARBOR_VERSION build arg.
// New versions are GitHub Releases of UPDATE_REPO, checked every 6 hours and
// cached. Applying one runs on the host (over the terminal SSH link, since the
// docker proxy can't pull or build): check out the release tag in
// HARBOR_HOST_DIR, rebuild the image and recreate the container. That last step
// kills us, so the script runs detached and writes to a log we read back.
// HARBOR_DEMO=1 fakes all of it so the interface can be tried without Docker.
import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";
import { demo } from "./demo.js";
import { hostExec, q } from "./host.js";

export const currentVersion = (process.env.HARBOR_VERSION || "").trim() || (demo ? "0.9.0" : "dev");
const repo = process.env.UPDATE_REPO || "doppIer/HarbourOS";
const hostDir = (process.env.HARBOR_HOST_DIR || "").trim();
const EVERY = 6 * 3600_000;
const cacheFile = path.join(env.dataDir, "update.json");

export interface Release { version: string; notes: string; url: string; publishedAt: string }
export interface UpdateJob { state: "idle" | "running" | "restarting" | "failed"; step: string; log: string[]; error?: string; target?: string; started?: number }
export interface UpdateStatus {
  current: string; latest: Release | null; available: boolean; checkedAt: number; error?: string;
  canApply: boolean; applyHint?: string; job: UpdateJob;
}

let cache: { latest: Release | null; checkedAt: number; error?: string } = { latest: null, checkedAt: 0 };
try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch {}
let job: UpdateJob = { state: "idle", step: "", log: [] };
let checking: Promise<void> | null = null;

const parts = (v: string) => v.replace(/^v/i, "").split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
export function newer(a: string, b: string) { // is a newer than b?
  if (b === "dev") return false; // a local build never nags
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

const DEMO_RELEASE: Release = {
  version: "1.0.0", url: `https://github.com/${repo}/releases`, publishedAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
  notes: "## What's new\n- Update card in Settings with one-click updates\n- Wall mode uses less CPU on old tablets\n- Store installs show progress per image\n\n## Fixes\n- Night mode no longer flickers at sunset",
};

async function fetchLatest(): Promise<Release | null> {
  if (demo) return DEMO_RELEASE;
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "HarbourOS-updater" }, signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 404) return null; // no releases yet
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  const j = await r.json() as any;
  return { version: String(j.tag_name ?? "").replace(/^v/i, ""), notes: String(j.body ?? "").slice(0, 20_000), url: String(j.html_url ?? ""), publishedAt: String(j.published_at ?? "") };
}

export function check(force = false): Promise<void> {
  if (!force && Date.now() - cache.checkedAt < EVERY) return Promise.resolve();
  return (checking ??= (async () => {
    try { cache = { latest: await fetchLatest(), checkedAt: Date.now() }; }
    catch (e) { cache = { ...cache, checkedAt: Date.now(), error: (e as Error).message }; }
    try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch {}
  })().finally(() => { checking = null; }));
}

function applyHint(): string | undefined {
  if (demo) return undefined;
  if (env.terminalMode !== "ssh") return "Updates run on the host over SSH. Set TERMINAL_MODE=ssh (see host/setup-terminal.sh).";
  if (!hostDir) return "Set HARBOR_HOST_DIR to the HarbourOS folder on the host (docker-compose.yml does this for you).";
  return undefined;
}

export async function status(): Promise<UpdateStatus> {
  await check();
  const latest = cache.latest;
  return {
    current: version(), latest, checkedAt: cache.checkedAt, error: cache.error,
    available: !!latest?.version && newer(latest.version, version()),
    canApply: !applyHint(), applyHint: applyHint(), job,
  };
}

const say = (line: string, step?: string) => { job.log = [...job.log, line].slice(-200); if (step) job.step = step; };

async function runDemo(target: string) {
  const steps: [string, string, number][] = [
    ["Downloading", `Fetching tag v${target} from ${repo}`, 1200],
    ["Downloading", "Checked out v" + target, 800],
    ["Building", "Building image harboros:latest", 1500],
    ["Building", "Step 3/3: npm run build — done", 1500],
    ["Restarting", "Recreating container harboros-harbor-1", 1000],
  ];
  for (const [step, line, ms] of steps) { say(line, step); await new Promise((r) => setTimeout(r, ms)); }
  job.state = "restarting"; say("Waiting for HarbourOS to come back…", "Restarting");
  await new Promise((r) => setTimeout(r, 2500));
  // Pretend we came back on the new version: the next status shows no update.
  (globalThis as any).__harborDemoVersion = target;
  job = { state: "idle", step: "", log: [] };
}

async function runHost(target: string) {
  const log = `/tmp/harbour-update-${Date.now()}.log`;
  const tag = `v${target}`;
  const script = [
    "set -e", `cd ${q(hostDir)}`,
    `echo "::step Downloading"`, "git fetch --tags --force origin", `git -c advice.detachedHead=false checkout --force ${q(tag)}`,
    `echo "::step Building"`, `HARBOR_VERSION=${q(target)} docker compose build harbor`,
    `echo "::step Restarting"`, `HARBOR_VERSION=${q(target)} docker compose up -d harbor`,
  ].join("\n");
  // Detached so it survives our container being replaced.
  const start = await hostExec(`nohup setsid bash -c ${q(script + "\necho ::done")} > ${q(log)} 2>&1 < /dev/null & echo started`);
  if (start.code !== 0) throw new Error(start.err || "Could not start the update on the host.");
  for (let i = 0; i < 1800; i++) { // up to an hour
    await new Promise((r) => setTimeout(r, 2000));
    const r = await hostExec(`cat ${q(log)} 2>/dev/null; pgrep -f ${q(log)} >/dev/null || echo ::exited`);
    const lines = r.out.toString().split("\n").filter(Boolean);
    const step = [...lines].reverse().find((l) => l.startsWith("::step "));
    job.log = lines.filter((l) => !l.startsWith("::")).slice(-200);
    if (step) job.step = step.slice(7);
    if (job.step === "Restarting") job.state = "restarting";
    if (lines.includes("::done")) return; // container is about to be replaced
    if (lines.includes("::exited")) throw new Error(job.log[job.log.length - 1] || "The update stopped on the host.");
  }
  throw new Error("The update took longer than an hour.");
}

export function apply(): UpdateJob {
  if (job.state === "running" || job.state === "restarting") return job;
  const latest = cache.latest;
  if (!latest || !newer(latest.version, version())) throw Object.assign(new Error("There is no newer version to install."), { statusCode: 400 });
  const hint = applyHint();
  if (hint) throw Object.assign(new Error(hint), { statusCode: 400 });
  if (!/^[\w.+-]+$/.test(latest.version)) throw Object.assign(new Error("The release has an unexpected tag."), { statusCode: 400 });
  job = { state: "running", step: "Starting", log: [], target: latest.version, started: Date.now() };
  (demo ? runDemo : runHost)(latest.version).catch((e) => { job = { ...job, state: "failed", error: (e as Error).message }; });
  return job;
}

export function dismissFailure() { if (job.state === "failed") job = { state: "idle", step: "", log: [] }; }

const version = () => (globalThis as any).__harborDemoVersion ?? currentVersion;
export const runningVersion = version;

/** Background check, so the badge shows without anyone opening Settings. */
export function startUpdateChecks() { check().catch(() => {}); setInterval(() => check().catch(() => {}), EVERY).unref(); }
