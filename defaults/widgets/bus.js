// Next departures for the lines you picked (line + direction + stop), from
// the city's timetable (GTFS). Long press → Options to add lines.
// Edit freely: loaded live by HarbourOS.
export default {
  title: "Departures",
  sizes: ["m", "tall", "l", "w", "s"],
  mount(el, { ui, api, size, opts }) {
    const head = ui.h("div", { class: "k", style: { marginBottom: "12px", display: "flex", gap: "6px" } });
    const list = ui.h("div", { style: { display: "grid", gap: "10px", alignContent: "start" } });
    el.append(head, list);
    const badge = (d) => ui.h("span", { class: "mono", style: { minWidth: "48px", textAlign: "center", padding: "5px 8px", borderRadius: "10px", fontWeight: "600",
      background: d.color || "var(--acc)", color: "#fff", flex: "none" } }, d.line);
    const mins = (d) => d.in === 0 ? "now" : `${d.in}′`;
    const ellip = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
    let picks = [];
    try { picks = JSON.parse(opts.picks || "[]"); } catch {}

    const drawBoard = (rows) => {
      head.replaceChildren(ui.icon("bus-linear", 15), "Departures");
      list.replaceChildren(...rows.map((p) => {
        const [first, ...rest] = p.departures;
        const short = p.line.split(" ").pop();
        return ui.h("div", { style: { display: "flex", alignItems: "center", gap: "12px" } },
          badge(first ?? { line: short }),
          ui.h("span", { style: { flex: "1", minWidth: "0", display: "grid" } },
            ui.h("span", { style: ellip }, `→ ${p.to || first?.to || ""}`),
            ui.h("span", { class: "k", style: ellip }, p.error || `from ${p.stop}${first ? ` · ${first.at}` : ""}`)),
          ui.h("span", { style: { textAlign: "right", display: "grid" } },
            ui.h("span", { class: "mono", style: { fontSize: "20px", fontWeight: "600" } }, first ? mins(first) : "–"),
            ui.h("span", { class: "k mono", style: { justifyContent: "flex-end" } }, rest.map(mins).join(" "))));
      }));
    };
    const drawStop = (r) => {
      head.replaceChildren(ui.icon("bus-linear", 15), r.stop);
      if (!r.departures.length) { list.replaceChildren(ui.h("div", { class: "muted" }, "No departures in the next 3 hours.")); return; }
      const max = size === "s" ? 3 : size === "m" ? 4 : 8;
      list.replaceChildren(...r.departures.slice(0, max).map((d) => ui.h("div", { style: { display: "flex", alignItems: "center", gap: "12px" } },
        badge(d), ui.h("span", { style: { flex: "1", minWidth: "0", ...ellip } }, d.to),
        ui.h("span", { class: "k mono" }, d.at),
        ui.h("span", { class: "mono", style: { fontSize: "18px", fontWeight: "600", minWidth: "44px", textAlign: "right" } }, mins(d)))));
    };
    const fail = (e) => list.replaceChildren(ui.h("div", { class: "muted" }, e.message));
    const city = opts.gtfs || opts.city || "riga";
    const load = () => {
      if (picks.length) return api(`/api/transit/board?${new URLSearchParams({ city, picks: JSON.stringify(picks), limit: "3" })}`).then(drawBoard).catch(fail);
      if (opts.stop) return api(`/api/transit/departures?${new URLSearchParams({ city, stop: opts.stop, lines: opts.lines || "", limit: "12" })}`).then(drawStop).catch(fail);
      head.textContent = "Departures";
      list.replaceChildren(ui.h("div", { class: "muted" }, "Long press → Options: add a bus or tram, its direction and your stop."));
    };
    load();
    const t = setInterval(load, 30_000);
    return { destroy() { clearInterval(t); } };
  },
};
