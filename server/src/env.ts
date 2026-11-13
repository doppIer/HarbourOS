import path from "node:path";

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
  sessionSecret: e.SESSION_SECRET ?? "dev-secret-change-me",
  trustTailscale: e.TRUST_TAILSCALE_HEADERS === "1",
  tailscaleUsers: (e.TAILSCALE_ALLOWED_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  claudeModel: e.CLAUDE_MODEL ?? "claude-opus-5-5",
  terminalMode: (e.TERMINAL_MODE ?? "local") as "ssh" | "local",
  sshTarget: e.TERMINAL_SSH_TARGET ?? "harbor@host.docker.internal",
  sshKey: e.TERMINAL_SSH_KEY ?? "/data/ssh/id_ed25519",
};
