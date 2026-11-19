// Every running container with its Docker IP and published ports.
// Ports open on this server (same address you use for HarbourOS); click an IP to copy it.
export default {
  title: "Container IPs",
  sizes: ["m", "l", "tall", "w"],
  mount(el, { ui }) {
    el.style.gap = "8px";
    const head = ui.h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" } });
    const count = ui.h("span", { class: "k mono" });
    const filter = ui.h("input", { placeholder: "Filter", style: { background: "rgba(255,255,255,.05)", border: "1px solid var(--line)", borderRadius: "8px", color: "inherit", font: "inherit", fontSize: "12px", padding: "2px 8px", width: "110px" } });
    head.append(ui.h("div", { class: "k" }, "Container IPs ", count), filter);
    const list = ui.h("div", { style: { overflow: "auto", minHeight: "0", flex: "1", display: "flex", flexDirection: "column", gap: "2px" } });
    el.append(head, list);

    const base = (p) => {
      // A port bound to one specific address is only reachable there; 0.0.0.0 / :: means "any", so use the address HarbourOS is on.
      const ip = p.ip && !["0.0.0.0", "::", ""].includes(p.ip) ? p.ip : location.hostname;
      return /^127\.|^::1$|^localhost$/.test(ip) && !/^127\.|^localhost$/.test(location.hostname) ? null : ip.includes(":") ? `[${ip}]` : ip;
    };
    const chip = (text, attrs) => ui.h("a", { ...attrs, style: { fontSize: "11.5px", padding: "1px 7px", borderRadius: "8px", background: "rgba(255,255,255,.06)", color: "var(--acc)", cursor: "pointer", textDecoration: "none", whiteSpace: "nowrap" } }, text);
    const copy = (ip, a) => {
      navigator.clipboard?.writeText(ip).then(() => { const t = a.textContent; a.textContent = "copied"; setTimeout(() => (a.textContent = t), 900); }).catch(() => {});
    };

    let last = [];
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      const rows = last.filter((c) => !q || c.name.toLowerCase().includes(q) || (c.ips ?? []).some((n) => n.ip.includes(q)) || (c.ports ?? []).some((p) => String(p.public).includes(q)));
      list.innerHTML = "";
      for (const c of rows) {
        const row = ui.h("div", { style: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 0", borderBottom: "1px solid var(--line)", flexWrap: "wrap" } });
        row.append(ui.h("span", { style: { fontWeight: "600", fontSize: "13px", flex: "1 1 120px", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: c.stack ? `${c.name} · ${c.stack}` : c.name }, c.name));
        for (const n of c.ips ?? []) {
          const a = chip(n.ip, { title: `${n.network} · click to copy`, class: "mono" });
          a.style.color = "var(--t2)";
          a.addEventListener("click", () => copy(n.ip, a));
          row.append(a);
        }
        for (const p of (c.ports ?? []).filter((p) => p.type === "tcp")) {
          const b = base(p);
          if (!b) continue;
          const scheme = [443, 8443, 9443].includes(p.private) ? "https" : "http";
          row.append(chip(`:${p.public} ↗`, { href: `${scheme}://${b}:${p.public}`, target: "_blank", rel: "noopener", title: `${scheme}://${b}:${p.public} → container ${p.private}`, class: "mono" }));
        }
        if (!(c.ips ?? []).length && !(c.ports ?? []).length) row.append(ui.h("span", { class: "k" }, "host network"));
        list.append(row);
      }
      if (!rows.length) list.append(ui.h("div", { class: "k" }, q ? "No match." : "No running containers."));
      count.textContent = `· ${rows.length}`;
    };
    filter.addEventListener("input", render);

    let sig = "";
    return {
      update({ containers }) {
        last = containers.filter((c) => c.state === "running").sort((a, b) => a.name.localeCompare(b.name));
        // only redraw when addresses change, not on every usage tick
        const s = JSON.stringify(last.map((c) => [c.name, c.ips, c.ports]));
        if (s !== sig) { sig = s; render(); }
      },
    };
  },
};
