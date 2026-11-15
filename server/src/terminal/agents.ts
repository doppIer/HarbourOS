// Coding agents the AI page can open. Each runs in its own tmux session on
// the host as the terminal user, installs itself on first use (user-level,
// no sudo) and then shows the tool's own sign-in. "ollama:<model>" chats with
// a local model through Ollama, installed on the host or running in Docker.
import { hostExec } from "../host.js";

const PATHS = 'export PATH="$HOME/.local/bin:$HOME/.hermes/bin:$HOME/.npm-global/bin:$PATH"';
const say = (s: string) => `printf '\\033[1m%s\\033[0m\\n' ${JSON.stringify(s)}`;
const fail = (s: string) => `{ printf '\\n%s\\nPress Enter to close.' ${JSON.stringify(s)}; read _; exit 1; }`;
const loop = (cmd: string, name: string) => `while true; do ${cmd}; printf '\\n${name} exited. Press Enter to start it again.'; read _; done`;
const npmInstall = (pkg: string, name: string) => [
  'if ! command -v npm >/dev/null; then',
  `  ${fail(`${name} needs Node.js 20+ on the server. Install it (e.g. sudo apt install nodejs npm), then open this again.`)}`,
  'fi',
  say(`Installing ${name}...`),
  `npm install -g --prefix "$HOME/.local" ${pkg} || ${fail("Install failed.")}`,
].join("\n");

export const AGENTS = {
  claude: { bin: "claude", install: `${say("Installing Claude Code...")}\ncurl -fsSL https://claude.ai/install.sh | bash || ${fail("Install failed.")}`, run: loop("claude", "Claude Code") },
  gemini: { bin: "gemini", install: npmInstall("@google/gemini-cli", "Gemini CLI"), run: loop("gemini", "Gemini CLI") },
  codex: { bin: "codex", install: npmInstall("@openai/codex", "Codex"), run: loop("codex", "Codex") },
  hermes: { bin: "hermes", install: `${say("Installing Hermes Agent...")}\ncurl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash || ${fail("Install failed.")}`, run: loop("hermes", "Hermes") },
} as const;
export type AgentId = keyof typeof AGENTS;

// Finds the ollama command: on the host, or inside a running Ollama container.
const OLLAMA = [
  'if command -v ollama >/dev/null; then OLLAMA="ollama";',
  "else C=$(docker ps --format '{{.Names}} {{.Image}}' 2>/dev/null | awk '$2 ~ /ollama/ {print $1; exit}');",
  '  [ -n "$C" ] && OLLAMA="docker exec -it $C ollama"; fi',
].join("\n");

export const validModel = (m: string) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,80}$/.test(m);

/** The shell script tmux runs for `program`, or null for a plain shell. */
export function script(program?: string): string | null {
  if (!program) return null;
  if (program in AGENTS) {
    const a = AGENTS[program as AgentId];
    return [PATHS, `if ! command -v ${a.bin} >/dev/null; then`, a.install, "fi", a.run].join("\n");
  }
  if (program.startsWith("ollama:") && validModel(program.slice(7))) {
    const model = program.slice(7);
    return [
      OLLAMA,
      `[ -z "$OLLAMA" ] && ${fail("Ollama isn't on the server. Install it (curl -fsSL https://ollama.com/install.sh | sh) or run the ollama/ollama container, then open this again.")}`,
      say(`Local model ${model} (downloads on first use). Type /bye to leave.`),
      loop(`$OLLAMA run '${model}'`, model),
    ].join("\n");
  }
  return null;
}

/** Which agents are installed, which sessions run, and the local models. */
export async function agentStatus() {
  const r = await hostExec([
    PATHS,
    `for b in ${Object.values(AGENTS).map((a) => a.bin).join(" ")}; do command -v $b >/dev/null && echo "bin $b"; done`,
    "tmux ls -F '#{session_name}' 2>/dev/null | sed 's/^/tmux /'",
    OLLAMA,
    '[ -n "$OLLAMA" ] && { echo "ollama yes"; $OLLAMA list 2>/dev/null | tail -n +2 | awk \'{print "model "$1" "$3$4}\'; }',
  ].join("\n").replace("docker exec -it", "docker exec"));
  const lines = r.out.toString().split("\n");
  const pick = (k: string) => lines.filter((l) => l.startsWith(k + " ")).map((l) => l.slice(k.length + 1));
  return {
    installed: pick("bin"),
    sessions: pick("tmux"),
    ollama: pick("ollama").length > 0,
    models: pick("model").map((l) => { const [name, size] = l.split(" "); return { name, size }; }),
  };
}
