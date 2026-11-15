// Next departures at one stop, from the city's timetable (GTFS).
// Long press → options: city, stop, lines. Edit freely: loaded live by HarborOS.
export default {
  title: "Departures",
  sizes: ["m", "tall", "l", "s", "w"],
  mount(el, { ui, api, size, opts }) {
    const head = ui.h("div", { class: "k", style: { marginBottom: "12px", display: "flex", gap: "6px" } });
    const list = ui.h("div", { style: { display: "grid", gap: "8px", alignContent: "start" } });
    el.append(head, list);
    const max = size === "s" ? 3 : size === "m" ? 4 : 8;
    const draw = (r) => {
      head.replaceChildren(ui.icon("bus-linear", 15), r.stop);
      if (!r.departures.length) { list.replaceChildren(ui.h("div", { class: "muted" }, "No departures in the next 3 hours.")); return; }
      list.replaceChildren(...r.departures.slice(0, max).map((d) => ui.h("div", { style: { display: "flex", alignItems: "center", gap: "12px" } },
        ui.h("span", { class: "mono", style: { minWidth: "44px", textAlign: "center", padding: "4px 8px", borderRadius: "10px", fontWeight: "600",
          background: d.color || "var(--acc)", color: "#fff" } }, d.line),
        ui.h("span", { style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, d.to),
        ui.h("span", { class: "mono", style: { fontSize: "18px", fontWeight: "600" } }, d.in === 0 ? "now" : `${d.in}′`))));
    };
    const load = () => {
      if (!opts.stop) { head.textContent = "Departures"; list.replaceChildren(ui.h("div", { class: "muted" }, "Long press → Options: pick a city, a stop and your lines.")); return; }
      const q = new URLSearchParams({ city: opts.gtfs || opts.city || "riga", stop: opts.stop, lines: opts.lines || "", limit: "12" });
      api(`/api/transit/departures?${q}`).then(draw).catch((e) => { head.textContent = opts.stop; list.replaceChildren(ui.h("div", { class: "muted" }, e.message)); });
    };
    load();
    const t = setInterval(load, 30_000);
    return { destroy() { clearInterval(t); } };
  },
};
