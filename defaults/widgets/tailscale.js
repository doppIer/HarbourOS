// Tailscale: is this server on the tailnet, its address, and which devices are online.
// Full details need tailscaled's socket mounted (see docker-compose.yml).
export default {
  title: "Tailscale",
  sizes: ["s", "m", "tall", "l"],
  mount(el, { ui, api, size }) {
    el.style.gap = "3px";
    const head = ui.h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } });
    const admin = ui.h("a", { href: "https://login.tailscale.com/admin/machines", target: "_blank", rel: "noopener", style: { fontSize: "12px", color: "var(--acc)", textDecoration: "none" } }, "Admin console ↗");
    head.append(ui.h("div", { class: "k" }, "Tailscale"), admin);
    const state = ui.h("div", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "18px", fontWeight: "600" } });
    const dot = ui.h("span", { style: { width: "10px", height: "10px", borderRadius: "50%", background: ui.theme.t4, flex: "none" } });
    const label = ui.h("span", {}, "–");
    state.append(dot, label);
    const me = ui.h("div", { class: "k mono", style: { display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } });
    const warn = ui.h("div", { style: { fontSize: "12px", color: ui.theme.warn } });
    const peers = ui.h("div", { style: { overflow: "auto", minHeight: "0", flex: "1", display: size === "s" ? "none" : "flex", flexDirection: "column", gap: "2px", marginTop: "2px" } });
    el.append(head, state, me, warn, peers);

    const copyable = (text) => {
      const s = ui.h("span", { class: "mono", title: "Click to copy", style: { cursor: "pointer" } }, text);
      s.addEventListener("click", () => navigator.clipboard?.writeText(text).then(() => { s.textContent = "copied"; setTimeout(() => (s.textContent = text), 900); }).catch(() => {}));
      return s;
    };

    const load = async () => {
      let s;
      try { s = await api("/api/tailscale"); } catch (e) { label.textContent = "Unknown"; warn.textContent = String(e.message ?? e); return; }
      const ok = s.online;
      dot.style.background = ok ? ui.theme.ok : s.backendState === "NeedsLogin" ? ui.theme.warn : ui.theme.err;
      dot.style.boxShadow = ok ? `0 0 8px ${ui.theme.ok}` : "none";
      label.textContent = ok ? "Connected" : s.backendState ? s.backendState.replace(/([a-z])([A-Z])/g, "$1 $2") : "Down";
      const ip = s.self?.ips?.find((x) => !x.includes(":")) ?? s.self?.ips?.[0];
      me.textContent = "";
      me.append(...[s.self?.name, ip].filter(Boolean).flatMap((x, i) => [i ? " · " : "", x === ip ? copyable(x) : x]));
      if (s.tailnet) me.append(` · ${s.tailnet}`);
      const notes = [...(s.health ?? [])];
      if (s.keyExpiry) {
        const days = (new Date(s.keyExpiry) - Date.now()) / 86400e3;
        if (days < 14) notes.push(days < 0 ? "Node key expired" : `Node key expires in ${Math.ceil(days)} d`);
      }
      if (!s.available) notes.push("Mount tailscaled.sock for devices and health.");
      warn.textContent = notes.join(" · ");
      warn.style.color = s.available ? ui.theme.warn : ui.theme.t3;

      peers.innerHTML = "";
      if (s.peers?.length) {
        const on = s.peers.filter((p) => p.online).length;
        const names = s.peers.filter((p) => p.online).map((p) => p.name).join(", ");
        peers.append(ui.h("div", { class: "k", style: { display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, title: names },
          `Devices · ${on}/${s.peers.length} online` + (size === "m" && names ? ` · ${names}` : "")));
        if (size !== "m") for (const p of s.peers) {
          const row = ui.h("div", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12.5px", padding: "2px 0" } });
          row.append(
            ui.h("span", { style: { width: "7px", height: "7px", borderRadius: "50%", flex: "none", background: p.online ? ui.theme.ok : ui.theme.t4 } }),
            ui.h("span", { style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: p.online ? "" : "var(--t3)" }, title: p.dnsName }, p.name + (p.exitNode ? " (exit node)" : "")),
            ui.h("span", { class: "k" }, p.online ? p.os : p.lastSeen ? ui.fmt.ago(Date.parse(p.lastSeen)) + " ago" : "offline"),
          );
          const pip = p.ips.find((x) => !x.includes(":"));
          if (pip) { const c = copyable(pip); c.style.fontSize = "11.5px"; c.style.color = "var(--t3)"; row.append(c); }
          peers.append(row);
        }
      }
    };
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return { destroy() { clearInterval(t); } };
  },
};
