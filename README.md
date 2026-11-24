<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/wordmark-dark.png">
    <img src="docs/brand/wordmark-light.png" alt="HarbourOS" width="420">
  </picture>
</p>

<p align="center">
  <b>A self-hosted desktop for your home server, in one browser tab.</b><br>
  Open every service, run containers, use a terminal and Claude, and turn a spare tablet into a wall display.
</p>

<p align="center">
  <img alt="Docker Compose" src="https://img.shields.io/badge/Docker-compose-3F3DB8?style=flat-square&logo=docker&logoColor=F3E9DC">
  <img alt="Tailscale" src="https://img.shields.io/badge/Tailscale-private-3F3DB8?style=flat-square&logo=tailscale&logoColor=F3E9DC">
  <img alt="PWA" src="https://img.shields.io/badge/PWA-desktop%20%2B%20tablet-3F3DB8?style=flat-square&logo=pwa&logoColor=F3E9DC">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3F3DB8?style=flat-square&logo=typescript&logoColor=F3E9DC">
</p>

<p align="center">
  <img src="docs/screenshots/home.png" alt="HarbourOS desktop: sidebar with apps, live stats, and a small now-playing pill next to Customize" width="100%">
</p>

## Quick start

You need a Linux server with Docker and [Tailscale](https://tailscale.com) (signed in with `sudo tailscale up`), so only your own devices can reach it.

**1. Download HarbourOS**

```bash
git clone https://github.com/doppIer/HarbourOS.git && cd HarbourOS
```

**2. Install it**

```bash
./install.sh
```

It finds your Tailscale address, builds and starts the latest release, sets up the browser terminal and one-click updates, and asks whether to turn on https (needed for passkeys). At the end it prints the address to open.

**3. Open it**

Open the address it printed and create the first account. That account is the admin.

<details>
<summary>Install by hand instead</summary>

```bash
cp .env.example .env    # then set TAILSCALE_IP to the output of: tailscale ip -4
```

```bash
HARBOR_VERSION=$(git describe --tags --abbrev=0 | sed 's/^v//') docker compose up -d --build
```

```bash
sudo bash host/setup-terminal.sh
```

`TAILSCALE_IP` is there so HarbourOS listens on your tailnet address only, never on your LAN or the internet.

</details>

**Updating:** open **Settings → Updates** and press **Update**. A dot on Settings tells you when a new version is out.

<details>
<summary>Optional extras</summary>

| What | Command |
|---|---|
| HTTPS on your tailnet (needed for some browser features) | `sudo bash host/setup-https.sh` |
| Now Playing for AirPlay / Spotify Connect on the server's speaker | `sudo bash host/setup-nowplaying.sh` |
| Real CPU power readings | `sudo bash host/rapl-permissions.sh` |

</details>

## Uninstall

Run these on the server, from the HarbourOS folder. Skip any step for something you never set up.

**1. Turn off the optional extras**

```bash
sudo bash host/setup-https.sh off
```

```bash
sudo bash host/setup-nowplaying.sh off
```

```bash
sudo systemctl disable --now rapl-read.service; sudo rm -f /etc/systemd/system/rapl-read.service; sudo systemctl daemon-reload
```

**2. Remove apps installed from the store** (keeps their files in `/srv/harbor`, see step 6)

```bash
for d in /home/harbor/harbor-stacks/*/; do sudo docker compose -p "$(basename "$d")" -f "$d/compose.yml" --env-file "$d/.env" down --remove-orphans; done
```

**3. Stop HarbourOS and remove its containers and images**

```bash
sudo docker compose down --rmi all --remove-orphans
```

**4. Remove the terminal user and its folder access**

```bash
d="$PWD"; while d="$(dirname "$d")"; [ "$d" != / ]; do sudo setfacl -x u:harbor "$d" 2>/dev/null; done; sudo userdel -r harbor
```

**5. Delete the HarbourOS folder** (accounts, settings and history live in its `data/` folder)

```bash
cd .. && sudo rm -rf HarbourOS
```

**6. Delete your apps' files** (only if you don't want them any more: this is the data of every app you installed from the store)

```bash
sudo rm -rf /srv/harbor
```

## Make it yours: drag and drop

Arrange things by dragging. No config files.

- **Sidebar:** drag an app to move it.
- **Dashboard:** press **Customize**, then drag tiles to reorder them. Each tile also has buttons to change its size or remove it.
- **Wall:** on the tablet, long-press any tile to edit, then use the tile's buttons to move, resize or remove it.

> [!IMPORTANT]
> Don't expose port 7080 to the internet. Compose binds it to your Tailscale IP only.

## What's inside

**Desktop**
- Every self-hosted app in one sidebar, opened inside HarbourOS (or in a tab when an app refuses frames). Stopped apps start when you open them and can stop again when idle.
- Live dashboard with editable widgets: CPU, memory, power and cost, network, disks, containers.
- Containers: start, stop, restart, remove, logs.
- App store with the CasaOS catalog, with a clear warning before anything gets deep access to the host.
- Files, a browser terminal (tmux), and Claude / local models that can look at your server and propose actions you approve.
- Accounts for the household: admins and members, sign-up with approval.

**Wall mode** (`/wall`, made for a tablet that stays on)
- Ready-made layouts (Home, Agenda, Commute, Bedside, Server) or your own; each person and each tablet has their own wall.
- Clock (big digits, watch face or flip cards), weather, calendar (iCloud / Google share link), bus and tram departures from any GTFS timetable, server stats.
- **Now Playing:** play to the server's speaker from your phone (AirPlay or Spotify Connect) and the wall shows the song full screen, with controls and volume.
- **DJ mode** for your Navidrome library.
- **Night mode:** from midnight to 6 a.m. everything turns red and the wall shows only the time and weather.
- ASCII animal backgrounds, light and dark, screen dimming, burn-in protection, pairing tablets with a code.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/wall.png" alt="Wall mode: big clock over an ASCII koi background, weather, now playing and server tiles"><br><sub><b>Wall mode.</b> Big clock, weather, music and server at a glance.</sub></td>
    <td width="50%"><img src="docs/screenshots/now-playing.png" alt="Full-screen Now Playing with cover, song, progress, controls and volume"><br><sub><b>Now Playing.</b> Opens by itself when your phone plays to the server.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/night.png" alt="Night mode: big red clock and weather on black"><br><sub><b>Night mode.</b> Red, dark, only time and weather.</sub></td>
    <td><img src="docs/screenshots/wall-watch.png" alt="Wall with a watch-face clock"><br><sub><b>Watch face.</b> One of three clock styles.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/night-watch.png" alt="Night mode with a red watch face"><br><sub><b>Night watch face.</b></sub></td>
    <td><img src="docs/screenshots/dj.png" alt="DJ mode with album grid and big player controls"><br><sub><b>DJ mode.</b> Your Navidrome library on the tablet.</sub></td>
  </tr>
</table>

<p align="center"><sub>Screenshots use the built-in demo mode (<code>HARBOR_DEMO=1</code>); the music is a made-up example.</sub></p>

## Security in short

Every API and WebSocket needs a session, members can't reach admin actions, and the app runs as an unprivileged user. The terminal is a real shell on your host and its user can run Docker, so **admin means root on the server**: give it only to people you'd trust with that. Details in the [guide](docs/GUIDE.md#security-notes).

## More

- [Full guide](docs/GUIDE.md): setup details, apps, store, widgets, backgrounds, HTTPS, wall, development.
- Try it without a server: `HARBOR_DEMO=1` simulates data (the screenshots use it).

## Credits

ASCII animal backgrounds: [ascii-animals](https://github.com/DesignerStephen1/ascii-animals) by DesignerStephen1 (MIT).
