import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * `virtual:solar` — only the Solar icons the UI actually references
 * (every "solar:<name>" string in src/), inlined at build time.
 * No CDN calls at runtime. The full set is lazy-loaded only by the icon picker.
 */
function solarIcons(): Plugin {
  const id = "virtual:solar";
  return {
    name: "solar-icons",
    resolveId: (s) => (s === id ? "\0" + id : null),
    load(s) {
      if (s !== "\0" + id) return;
      const set = JSON.parse(fs.readFileSync(require.resolve("@iconify-json/solar/icons.json"), "utf8"));
      const used = new Set<string>();
      const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
        const p = `${d}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|json)$/.test(e.name)) for (const m of fs.readFileSync(p, "utf8").matchAll(/solar:([a-z0-9-]+)/g)) used.add(m[1]);
      });
      walk("src");
      for (const m of fs.readFileSync("../config/harbor.example.json", "utf8").matchAll(/solar:([a-z0-9-]+)/g)) used.add(m[1]);
      const out: Record<string, string> = {};
      for (const n of used) {
        const name = set.icons[n] ? n : set.aliases?.[n]?.parent;
        if (name && set.icons[name]) out[n] = set.icons[name].body;
      }
      return `export default ${JSON.stringify(out)};`;
    },
    // Icon picker catalogue: only the "-linear" style, fetched on demand.
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "solar-linear.json", source: linearSet() });
    },
    configureServer(server) {
      server.middlewares.use("/solar-linear.json", (_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(linearSet()); });
    },
  };
}

function linearSet() {
  const set = JSON.parse(fs.readFileSync(require.resolve("@iconify-json/solar/icons.json"), "utf8"));
  const out: Record<string, string> = {};
  for (const [n, v] of Object.entries<any>(set.icons)) if (n.endsWith("-linear")) out[n] = v.body;
  return JSON.stringify(out);
}

export default defineConfig({
  plugins: [preact(), solarIcons()],
  build: { target: "es2022", cssCodeSplit: true, chunkSizeWarningLimit: 400 },
  server: {
    proxy: {
      "/api": "http://localhost:7080",
      "/ws": { target: "ws://localhost:7080", ws: true },
      "/widgets": "http://localhost:7080",
      "/user-icons": "http://localhost:7080",
      "/user-backgrounds": "http://localhost:7080",
    },
  },
});
