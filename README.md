# HarborOS

A self-hosted desktop for your home server, in one browser tab. It shows your services in a sidebar, starts and stops their containers, monitors the machine live, and includes a terminal and Claude. It installs as a PWA on desktop and iPhone.

Built to be cheap to leave running 24/7 on the box it watches:

- one Node process
- one WebSocket per browser tab
- metrics read straight from `/proc` and `/sys`
- the stats loop drops to one tick every 30 s when nobody is looking

```
browser ──(Tailscale)──► harbor (Node/Fastify) ──► docker-socket-proxy ──► dockerd
                              │  /host/proc, /host/sys (read-only)
                              │  ssh → host tmux (terminal, claude)
                              └  SQLite in ./data
```

## Setup

On the server, in this folder:

```bash
cp .env.example .env              # set TAILSCALE_IP, SESSION_SECRET, ANTHROPIC_API_KEY
mkdir -p data && cp config/harbor.example.json data/harbor.json   # edit URLs/containers to match yours
sudo bash host/setup-terminal.sh  # tmux + SSH key for the browser terminal
sudo bash host/rapl-permissions.sh   # optional, for the power estimate
docker compose up -d --build
```

Open `http://<TAILSCALE_IP>:7080`. The first visit shows **Set up HarborOS**: the account you create there is the admin.

`data/harbor.json` is read only on first boot. After that, apps live in SQLite and you manage them from the UI.

**Never expose port 7080 to the internet.** Compose binds it to your Tailscale IP only. To serve it over HTTPS with Tailscale identities instead of a password:

```bash
tailscale serve --bg 7080
```

Then set `TRUST_TAILSCALE_HEADERS=1` and `TAILSCALE_ALLOWED_USERS=you@example.com` in `.env`. When header auth is on, keep 7080 bound to `127.0.0.1` so only `tailscale serve` can reach it.

## Accounts

- **Admin:** can do everything.
- **Member:** sees the dashboard and opens apps. Can't use the terminal, Claude, container controls or settings; the server enforces this, not just the UI.
- **Sign-up:** the sign-in screen has a Sign up link while **Settings → Sign-in screen → Show "Sign up"** is on (the default). New accounts wait as "pending" until an admin approves them under **Settings → Users**, where you can also change roles or delete accounts. HarborOS always keeps at least one admin.
- **Passwords:** stored as scrypt hashes. Changing your password signs out your other devices.
- **Sign-in background:** the sign-in screen has its own background slot (**Settings → Sign-in screen**), with the same module contract as the desktop. The default, "aura", is a soft glow; pick None, an image/video URL, or a module from `data/backgrounds/`.

## Adding an app

Click **Add app** in the sidebar. You can set:

- name and icon (search Solar icons, upload a file, or paste a URL from Dashboard Icons or simple-icons)
- service URL
- the containers it uses, or a whole compose project
- a health check URL
- whether it starts when opened, stops after N idle minutes, starts on boot, or is always on

Link-only apps (no container) work too. Everything is saved on the server.

Right-click (or long-press on a phone) an app for Open, Restart, Stop, View logs, Open in new tab, Edit and Unpin. Drag apps to reorder them.

Some apps refuse to load inside an iframe because of `X-Frame-Options` or a CSP `frame-ancestors` header. For those, remove the header in your reverse proxy, or use **Open in new tab**.

## Dashboard widgets (customize without rebuilding)

Every tile on Home is a plain ES module in `data/widgets/`. Edit a file and save, and that tile reloads in every open browser. No build, no restart. If you break a widget, only its tile shows the error. Delete the file to get the default back. **Customize** on Home lets you reorder, resize (S/M/tall/L/W), add and remove tiles; the result is written to `data/widgets/layout.json`.

```js
// data/widgets/my-widget.js
export default {
  title: "Uptime",
  sizes: ["s", "m"],
  mount(el, { ui, size, actions }) {
    const n = ui.bigNumber(el, { label: "Uptime", unit: " days" });
    const spark = ui.sparkline(el, { color: ui.theme.teal });
    return {
      update({ stats, containers, apps, history }) {
        n.set((stats.uptime / 86400).toFixed(1));
        spark.set(history.cpu);
      },
      destroy() {},
    };
  },
};
```

`ctx.ui` gives you:

- `bigNumber`, `sparkline`, `area` (layered area chart with crosshair and trend card), `bar`, `legend`
- `h` (a tiny element builder)
- `fmt` (`bytes`, `rate`, `pct`, `dur`, `ago`) and `theme` colors

Charts share one canvas `requestAnimationFrame` loop and pause while the tab is hidden. `update` runs only when live data arrives. `actions.container(name, "start" | "stop" | "restart")` and `actions.open(view)` are available too. `data` has the full shapes (see `server/src/protocol.ts`).

## Custom background

Put a module in `data/backgrounds/<name>/index.js` and choose it under **Settings → Background**. No rebuild is needed. Images and videos work too: paste a URL.

```js
export function mount(el, { reducedMotion }) {
  // draw into el (canvas, DOM, …) using requestAnimationFrame
  return { pause() {}, resume() {}, destroy() {} };
}
```

HarborOS calls `pause()` when the tab is hidden or an app is open (both toggles are in Settings) and `resume()` when it's visible again. The background runs in its own isolated layer behind everything, and Settings also has dim and blur controls. A blank template ships as `/backgrounds/template/index.js`.

## Auto start and stop, Sablier and Traefik

- **Start on demand:** opening an app starts its containers, or its whole compose stack in `depends_on` order. A boot screen shows progress until the health check passes.
- **Idle stop:** an app counts as in use while any client is viewing it or something calls `POST /api/apps/<id>/activity`. Once it has been idle longer than its limit, it's stopped. Stacks stop in reverse dependency order. Apps marked "always on" are never stopped.
- **Traffic from outside HarborOS:** if you reach a service directly (for example Jellyfin from your TV) through Traefik with the [Sablier](https://github.com/sablierapp/sablier) plugin, let Sablier own those containers. Give them `sablier.enable=true` and `sablier.group=<app-id>` labels, and set that app's idle stop to 0 in HarborOS so they don't fight. HarborOS still shows status and can start them. To have HarborOS own idle stop instead, point any access-log hook or a Traefik `forwardAuth` middleware at `POST /api/apps/<id>/activity` with a session cookie.

## Power numbers

Live watts are **an estimate**: Intel RAPL CPU-package power plus a configurable baseline for the board, disks and PSU loss (Settings → Power). To use a real reading, add a Home Assistant smart-plug entity in Settings and HarborOS will use it instead. Daily kWh is accumulated in SQLite, and the monthly cost is the 30-day average times your price per kWh.

## Terminal and Claude

- **Terminal:** every tab is a `tmux` session on the **host**, reached over SSH with a key only the container has. Closing the browser doesn't end it. On iPhone there's an extra key row (Esc, Tab, sticky Ctrl, arrows, `| ~ / -`).
- **Claude, Chat tab:** uses `ANTHROPIC_API_KEY` on the server, which never reaches the browser. Claude can read live stats, containers and logs. Starting, stopping or restarting anything shows up as a card that you approve before it runs. Conversations are stored in SQLite. The model defaults to `claude-opus-5-5`; change it with `CLAUDE_MODEL`. Requests opt into the server-side refusal fallback (`server-side-fallback-2026-07-01`).
- **Claude, Claude Code tab:** a tmux session running `claude` on the host. Install the CLI for the terminal user and sign in once.

## Security notes

- The web container never sees the Docker socket. `docker-socket-proxy` allows only list, inspect, logs, events, start, stop and restart; exec, images, volumes, networks and build stay disabled.
- Every `/api` and `/ws` route requires a session (or an allowed Tailscale identity matching an active account). Members get a 403 on admin routes. Login and sign-up attempts are rate-limited, and session cookies are signed, `HttpOnly` and `SameSite=Strict`.
- Until the first account exists, anyone who can reach port 7080 can create the admin. Set it up right after `docker compose up`, or set `HARBOR_PASSWORD` in `.env`.
- `/proc`, `/sys` and `/` are mounted read-only. `/` is used only for disk usage numbers.
- The terminal is a full shell on your host. Every admin can use it, so give admin only to people you'd give SSH access.

## Development

```bash
cd server && npm install && HARBOR_PASSWORD=dev TERMINAL_MODE=local DATA_DIR=../data npx tsx watch src/index.ts
cd web && npm install && npm run dev   # proxies /api, /ws, /widgets to :7080
```

## Layout

```
server/src/   index, auth, hub (WS fan-out), db, collectors/, docker/, lifecycle/, terminal/, ai/, widgets/, protocol.ts
web/src/      shell/ (Sidebar, AppHost, Background, ContextMenu), home/, widgets/ (runtime + ui), apps/terminal, apps/ai, dialogs/
defaults/widgets/   shipped widget modules + layout, copied to data/widgets on first boot
host/         one-time host setup scripts
config/       sample apps
```
