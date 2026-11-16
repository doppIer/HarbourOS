import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const e = process.env;
export const env = {
  port: Number(e.PORT ?? 7080),
  dataDir: e.DATA_DIR ?? path.resolve("../data"),
  publicDir: e.PUBLIC_DIR ?? path.resolve("../web/dist"),
  defaultsDir: e.DEFAULTS_DIR ?? path.resolve("../defaults"),
  hostProc: e.HOST_PROC ?? "/proc",
  hostSys: e.HOST_SYS ?? "/sys",
  dockerHost: e.DOCKER_HOST ?? "http://127.0.0.1:2375",
  password: e.HARBOR_PASSWORD ?? "",
  sessionSecret: "",
  trustTailscale: e.TRUST_TAILSCALE_HEADERS === "1",
  tailscaleUsers: (e.TAILSCALE_ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  claudeModel: e.CLAUDE_MODEL ?? "claude-opus-5-5",
  terminalMode: (e.TERMINAL_MODE ?? "local") as "ssh" | "local",
  sshTarget: e.TERMINAL_SSH_TARGET ?? "harbor@host.docker.internal",
  sshKey: e.TERMINAL_SSH_KEY ?? "/data/ssh/id_ed25519",
  hostRoot: e.HOST_ROOT ?? "/",          // host "/" as seen by this process (/host/root in Docker)
  filesRoot: e.FILES_ROOT ?? "/",       // local mode only: what the Files app treats as "/"
  storeRepo: e.STORE_REPO ?? "IceWhaleTech/CasaOS-AppStore",
  storeBranch: e.STORE_BRANCH ?? "main",
};

// Cookie signing secret. A placeholder (or none) on a fresh install gets a random
// secret kept in data/. Existing installs keep the old one, because changing it
// signs everyone out and unpairs every wall tablet; they get a warning instead.
const WEAK = new Set(["", "dev-secret-change-me", "replace-with-random-string", "change-me"]);
const given = e.SESSION_SECRET ?? "";
if (!WEAK.has(given) && given.length >= 16) env.sessionSecret = given;
else {
  const file = path.join(env.dataDir, "session.secret");
  const existing = fs.existsSync(path.join(env.dataDir, "harbor.db"));
  try { env.sessionSecret = fs.readFileSync(file, "utf8").trim(); } catch {}
  if (!env.sessionSecret && existing) {
    env.sessionSecret = given || "dev-secret-change-me"; // what this install has been signing with
    console.warn("SESSION_SECRET is a placeholder. Set a long random one in .env (everyone will need to sign in again).");
  }
  if (!env.sessionSecret) {
    env.sessionSecret = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.writeFileSync(file, env.sessionSecret + "\n", { mode: 0o600 });
  }
}
