// Two big counts: running containers and the ones that need attention.
export default {
  title: "Containers",
  sizes: ["tall", "s"],
  mount(el, { ui, actions }) {
    el.style.gap = "14px";
    const block = (title, links) => {
      const wrap = ui.h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" } });
      const left = ui.h("div", {}, ui.h("div", { style: { fontWeight: "600", fontSize: "14px" } }, title),
        ui.h("div", { style: { fontSize: "12px", color: "var(--acc)", display: "flex", gap: "8px" } }, ...links));
      const num = ui.h("div", { class: "big", style: { fontSize: "52px" } }, "–");
      wrap.append(left, num);
      el.append(wrap);
      return num;
    };
    const link = (t, f) => ui.h("a", { style: { cursor: "pointer" }, onClick: f }, t);
    const running = block("Running", [link("View all", () => document.getElementById("containers")?.scrollIntoView({ behavior: "smooth" }))]);
    const tags = ui.h("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } });
    el.append(tags, ui.h("div", { style: { borderTop: "1px solid var(--line)" } }));
    const bad = block("Needs attention", [link("Logs", () => document.getElementById("activity")?.scrollIntoView({ behavior: "smooth" }))]);
    const list = ui.h("div", { class: "k mono", style: { lineHeight: "1.7", display: "block", overflow: "hidden", whiteSpace: "pre-line" } });
    el.append(list);
    const tag = (t, bg, fg) => ui.h("span", { style: { fontSize: "11px", background: bg, color: fg, padding: "1px 8px", borderRadius: "10px" } }, t);
    return {
      update({ containers }) {
        const run = containers.filter((c) => c.state === "running");
        const stacks = new Set(containers.map((c) => c.stack).filter(Boolean));
        const attention = containers.filter((c) => c.state === "restarting" || c.health === "unhealthy" || c.restartCount > 3
          || (c.idleSince && Date.now() - c.idleSince > 86400e3 && (c.mem ?? 0) > 512 * 2 ** 20));
        running.textContent = run.length;
        tags.innerHTML = "";
        tags.append(tag(`${stacks.size} stacks`, "#2a2a6e", "#b8b8ff"), tag(`${containers.length - run.length} stopped`, "rgba(255,255,255,.06)", "var(--t2)"));
        if (run.every((c) => c.health !== "unhealthy")) tags.append(tag("healthy", "#123d2c", "#7fe0b0"));
        bad.textContent = attention.length;
        bad.style.color = attention.length ? ui.theme.err : "";
        list.textContent = attention.slice(0, 5).map((c) =>
          c.restartCount > 3 ? `${c.name} ×${c.restartCount} restarts` : c.health === "unhealthy" ? `${c.name} unhealthy` : `${c.name} idle ${ui.fmt.ago(c.idleSince)} · ${ui.fmt.bytes(c.mem)}`).join("\n") || "All good.";
      },
    };
  },
};
