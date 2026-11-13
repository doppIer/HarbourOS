export default {
  title: "Disks",
  sizes: ["m", "s"],
  mount(el, { ui }) {
    el.append(ui.h("div", { class: "k" }, "Disks"));
    const list = ui.h("div", { style: { display: "grid", gap: "2px", marginTop: "6px", flex: "1", overflow: "hidden" } });
    const io = ui.h("div", { class: "k mono" });
    el.append(list, io);
    return {
      update({ stats }) {
        list.innerHTML = "";
        for (const d of stats.disks) {
          const pct = (d.used / d.total) * 100;
          const r = ui.h("div", { class: "mono", style: { fontSize: "12px", display: "flex", gap: "10px", alignItems: "center" } },
            ui.h("span", { style: { width: "60px", overflow: "hidden", textOverflow: "ellipsis" } }, d.mount));
          const b = ui.h("div", { style: { flex: "1" } }); ui.bar(b, { color: pct > 90 ? ui.theme.err : "" }).set(pct);
          r.append(b, ui.h("span", { class: "muted" }, `${Math.round(pct)}%  ${ui.fmt.bytes(d.total, 0)}`));
          list.append(r);
        }
        io.textContent = `read ${ui.fmt.rate(stats.diskIo.read)} · write ${ui.fmt.rate(stats.diskIo.write)}`;
      },
    };
  },
};
