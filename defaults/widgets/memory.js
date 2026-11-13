export default {
  title: "Memory",
  sizes: ["s", "m"],
  mount(el, { ui }) {
    const num = ui.bigNumber(el, { label: "Memory" });
    const bar = ui.bar(el, { color: ui.theme.teal });
    const sub = ui.h("div", { class: "k mono" });
    el.append(sub);
    return {
      update({ stats }) {
        const m = stats.mem, used = ui.fmt.bytes(m.used), total = ui.fmt.bytes(m.total, 0);
        num.set(used.v, ` / ${total} `);
        bar.set((m.used / m.total) * 100);
        sub.textContent = `swap ${ui.fmt.bytes(m.swapUsed)} · cache ${ui.fmt.bytes(m.cached)}`;
      },
    };
  },
};
