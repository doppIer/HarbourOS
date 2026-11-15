// Big clock and date. Edit freely: this file is loaded live by HarborOS.
// opts.seconds = "1" shows seconds; opts.h12 = "1" uses a 12-hour clock.
export default {
  title: "Clock",
  sizes: ["w", "m", "l", "s"],
  mount(el, { ui, size, opts }) {
    el.style.justifyContent = "center";
    const big = size === "s" ? 40 : size === "m" ? 64 : 96;
    const time = ui.h("div", { class: "big", style: { fontSize: `${big}px`, letterSpacing: "-0.04em", lineHeight: "1" } });
    const date = ui.h("div", { class: "k", style: { fontSize: `${Math.max(13, big / 5)}px`, marginTop: "10px" } });
    el.append(time, date);
    const tick = () => {
      const d = new Date();
      time.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(opts.seconds === "1" ? { second: "2-digit" } : {}), hour12: opts.h12 === "1" });
      date.textContent = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    };
    tick();
    const t = setInterval(tick, 1000);
    return { destroy() { clearInterval(t); } };
  },
};
