import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "./styles.css";
import { api, connect } from "./lib/ws";
import { loadSettings, me, type Me } from "./store";
import { Shell } from "./shell/Shell";
import { Login } from "./dialogs/Login";
import { Wall, Pair } from "./wall/Wall";

const onWall = location.pathname.replace(/\/$/, "") === "/wall";

function Root() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const check = () => api<{ authed: boolean; user: Me | null }>("/api/me")
    .then((r) => { me.value = r.user; setAuthed(r.authed); })
    .catch(() => setAuthed(false));
  useEffect(() => { check(); }, []);
  useEffect(() => { if (authed) { connect(); loadSettings(); } }, [authed]);
  const [useLogin, setUseLogin] = useState(false);
  if (authed === null) return <div style={{ position: "fixed", inset: 0, background: "#000" }} />;
  // A paired tablet only has the wall.
  if (authed && me.value?.role === "device" && !onWall) { location.replace("/wall"); return null; }
  if (onWall) return authed ? <Wall /> : useLogin ? <Login onDone={check} /> : <Pair onDone={check} signIn={() => setUseLogin(true)} />;
  return authed ? <Shell /> : <Login onDone={check} />;
}

render(<Root />, document.getElementById("app")!);

// After an update, old lazy chunks are gone: reload once to pick up the new build.
window.addEventListener("vite:preloadError", () => location.reload());

if ("serviceWorker" in navigator && import.meta.env.PROD) navigator.serviceWorker.register("/sw.js");
