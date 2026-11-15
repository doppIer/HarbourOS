// Clock. Edit freely: this file is loaded live by HarborOS.
// opts.style = "flip" (default) shows flip cards, "plain" shows big digits.
// opts.seconds = "1" shows seconds; opts.h12 = "1" uses a 12-hour clock.
export default {
  title: "Clock",
  sizes: ["w", "m", "l", "s"],
  mount(el, { ui, size, opts }) {
    return opts.style === "plain" ? plain(el, ui, size, opts) : flip(el, ui, opts);
  },
};

function parts(opts) {
  const d = new Date(), h = d.getHours();
  const hh = opts.h12 === "1" ? (h % 12 || 12) : h;
  return { d, ap: h < 12 ? "AM" : "PM", p: [String(hh).padStart(2, "0"), String(d.getMinutes()).padStart(2, "0"), String(d.getSeconds()).padStart(2, "0")] };
}

function plain(el, ui, size, opts) {
  el.style.justifyContent = "center";
  const big = size === "s" ? 40 : size === "m" ? 64 : 96;
  const time = ui.h("div", { class: "big", style: { fontSize: `${big}px`, letterSpacing: "-0.04em", lineHeight: "1" } });
  const date = ui.h("div", { class: "k", style: { fontSize: `${Math.max(13, big / 5)}px`, marginTop: "10px" } });
  el.append(time, date);
  const tick = () => {
    const { d, ap, p } = parts(opts);
    time.textContent = p.slice(0, opts.seconds === "1" ? 3 : 2).join(":") + (opts.h12 === "1" ? " " + ap : "");
    date.textContent = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  };
  tick();
  const t = setInterval(tick, 1000);
  return { destroy() { clearInterval(t); } };
}

const CSS = `
.fc{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:var(--gap);background:#000;border-radius:inherit}
.fc-card{position:relative;width:var(--w);height:var(--h);perspective:calc(var(--h)*4);font:700 var(--fs)/var(--h) "Helvetica Neue","Arial Narrow",system-ui,sans-serif;font-stretch:condensed;letter-spacing:-0.06em;color:#bdbdbd;text-align:center}
.fc-half{position:absolute;left:0;right:0;height:50%;overflow:hidden;background:#0c0c0c;backface-visibility:hidden}
.fc-half span{display:block;height:var(--h)}
.fc-top{top:0;border-radius:var(--r) var(--r) 0 0;background:linear-gradient(#141414,#0e0e0e);transform-origin:bottom}
.fc-bot{bottom:0;border-radius:0 0 var(--r) var(--r);transform-origin:top}
.fc-bot span{margin-top:calc(var(--h)/-2)}
.fc-card::after{content:"";position:absolute;left:0;right:0;top:50%;height:max(1px,calc(var(--h)/140));transform:translateY(-50%);background:#000;z-index:5}
.fc-ap{position:absolute;left:calc(var(--w)*.07);top:calc(var(--h)*.12);font-size:calc(var(--h)*.09);line-height:1;letter-spacing:0;color:#9a9a9a;z-index:6}
.fc-flip-top{z-index:3;animation:fc-a .3s ease-in forwards}
.fc-flip-bot{z-index:3;transform:rotateX(90deg);animation:fc-b .3s .3s ease-out forwards}
@keyframes fc-a{to{transform:rotateX(-90deg)}}
@keyframes fc-b{to{transform:rotateX(0)}}
`;

function flip(el, ui, opts) {
  if (!document.getElementById("fc-style")) document.head.append(Object.assign(document.createElement("style"), { id: "fc-style", textContent: CSS }));
  const root = document.createElement("div");
  root.className = "fc";
  el.append(root);
  const n = opts.seconds === "1" ? 3 : 2;
  const cards = Array.from({ length: n }, (_, i) => {
    const c = document.createElement("div");
    c.className = "fc-card";
    c.innerHTML = `<div class="fc-half fc-top"><span></span></div><div class="fc-half fc-bot"><span></span></div>${i === 0 && opts.h12 === "1" ? '<div class="fc-ap"></div>' : ""}`;
    root.append(c);
    return { c, val: "" };
  });

  const half = (cls, v) => {
    const h = document.createElement("div");
    h.className = `fc-half ${cls}`;
    h.innerHTML = `<span>${v}</span>`;
    return h;
  };
  const set = (card, v) => {
    if (card.val === v) return;
    const old = card.val;
    card.val = v;
    card.c.querySelector(".fc-top span").textContent = v;
    if (!old) { card.c.querySelector(".fc-bot span").textContent = v; return; }
    // Old top folds down over the new one, then the new bottom folds into place.
    const a = half("fc-top fc-flip-top", old), b = half("fc-bot fc-flip-bot", v);
    card.c.append(a, b);
    setTimeout(() => { card.c.querySelector(".fc-bot span").textContent = v; a.remove(); b.remove(); }, 620);
  };

  const fit = () => {
    const W = el.clientWidth, H = el.clientHeight;
    const gap = W * 0.025;
    const w = Math.min((W * 0.86 - gap * (n - 1)) / n, H * 0.78 / 0.98);
    const h = w * 0.98;
    Object.entries({ "--w": w, "--h": h, "--fs": h * 0.92, "--gap": gap, "--r": h * 0.06 })
      .forEach(([k, v]) => root.style.setProperty(k, v + "px"));
  };
  const tick = () => {
    const { ap, p } = parts(opts);
    cards.forEach((c, i) => set(c, p[i]));
    const a = root.querySelector(".fc-ap");
    if (a) a.textContent = ap;
  };
  fit(); tick();
  const ro = new ResizeObserver(fit); ro.observe(el);
  const t = setInterval(tick, 1000);
  return { destroy() { clearInterval(t); ro.disconnect(); root.remove(); } };
}
