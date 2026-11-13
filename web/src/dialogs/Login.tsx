// Sign in / sign up / first-run setup. One pill-shaped field at a time; the
// heading softly blurs while you type. The background is a replaceable slot
// (Settings → Sign-in screen), "aura" by default.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/ws";
import { BackgroundLayer } from "../shell/Background";
import { Icon } from "../icons/Icon";

type Mode = "login" | "signup" | "setup" | "forgot" | "reset";
interface Config { needsSetup: boolean; allowSignup: boolean; background: { module: string; dim: number; blur: number }; accent: string }
interface Step { key: "name" | "email" | "password" | "code"; type: string; placeholder: string; autoComplete: string }

const STEPS: Record<Mode, Step[]> = {
  forgot: [
    { key: "email", type: "email", placeholder: "Email address", autoComplete: "username" },
  ],
  reset: [
    { key: "code", type: "text", placeholder: "Reset code, e.g. K7QM-3XRP", autoComplete: "one-time-code" },
    { key: "password", type: "password", placeholder: "New password (8+ characters)", autoComplete: "new-password" },
  ],
  login: [
    { key: "email", type: "email", placeholder: "Email address", autoComplete: "username" },
    { key: "password", type: "password", placeholder: "Password", autoComplete: "current-password" },
  ],
  signup: [
    { key: "name", type: "text", placeholder: "Your name", autoComplete: "name" },
    { key: "email", type: "email", placeholder: "Email address", autoComplete: "username" },
    { key: "password", type: "password", placeholder: "Choose a password (8+ characters)", autoComplete: "new-password" },
  ],
  setup: [
    { key: "name", type: "text", placeholder: "Your name", autoComplete: "name" },
    { key: "email", type: "email", placeholder: "Email address", autoComplete: "username" },
    { key: "password", type: "password", placeholder: "Choose a password (8+ characters)", autoComplete: "new-password" },
  ],
};

const COPY: Record<Mode, { title: string; sub: string }> = {
  forgot: { title: "Reset your password", sub: "HarborOS doesn't send email. It writes a one-time code to the server log instead, or your admin can make one for you in Settings → Users." },
  reset: { title: "Enter your reset code", sub: "Run “docker compose logs harbor” on the server and look for “password reset”. The code works once, for 15 minutes." },
  login: { title: "Sign in to HarborOS", sub: "Your home server, one tab away. Sign in with the account your admin gave you." },
  signup: { title: "Create your account", sub: "An admin approves new accounts before you can sign in." },
  setup: { title: "Set up HarborOS", sub: "Create the first account. It becomes the admin for this server." },
};

export function Login({ onDone }: { onDone: () => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [mode, setMode] = useState<Mode>("login");
  const [step, setStep] = useState(0);
  const [vals, setVals] = useState({ name: "", email: "", password: "", code: "" });
  const [focused, setFocused] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Config>("/api/auth/config").then((c) => {
      setCfg(c);
      if (c.needsSetup) setMode("setup");
      document.documentElement.style.setProperty("--acc", c.accent);
    }).catch(() => setCfg({ needsSetup: false, allowSignup: false, background: { module: "aura", dim: 0, blur: 0 }, accent: "#7B7BF0" }));
  }, []);
  useEffect(() => { input.current?.focus(); setFocused(document.activeElement === input.current); }, [step, mode, cfg]);

  const steps = STEPS[mode];
  const cur = steps[step];
  const value = vals[cur.key];

  const switchMode = (m: Mode) => { setMode(m); setStep(0); setErr(""); setPending(false); setVals((v) => ({ ...v, password: "", code: "" })); };

  const next = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (cur.key === "name" && !value.trim()) return setErr("Enter your name.");
    if (cur.key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return setErr("Enter a valid email address.");
    if (cur.key === "password" && !value) return setErr("Enter your password.");
    if (cur.key === "code" && value.replace(/[^a-z0-9]/gi, "").length !== 8) return setErr("The code has 8 letters and digits.");
    if (cur.key === "password" && mode !== "login" && value.length < 8) return setErr("Use at least 8 characters.");
    setErr("");
    if (step < steps.length - 1) { setStep(step + 1); return; }

    setBusy(true);
    try {
      if (mode === "forgot") {
        await api("/api/password/forgot", { method: "POST", json: { email: vals.email } });
        setMode("reset"); setStep(0); return;
      }
      if (mode === "reset") {
        const r = await api<{ pending?: boolean }>("/api/password/reset", { method: "POST", json: { email: vals.email, code: vals.code, password: vals.password } });
        if (r.pending) { setPending(true); return; }
        onDone(); return;
      }
      if (mode === "login") {
        await api("/api/login", { method: "POST", json: { email: vals.email, password: vals.password } });
        onDone();
      } else {
        const r = await api<{ user?: unknown; pending?: boolean }>("/api/signup", { method: "POST", json: vals });
        if (r.pending) { setPending(true); setVals({ name: "", email: "", password: "", code: "" }); }
        else onDone();
      }
    } catch (x) {
      setErr((x as Error).message);
      if (cur.key === "password" && mode !== "reset") setVals((v) => ({ ...v, password: "" }));
    } finally { setBusy(false); }
  };

  if (!cfg) return <div class="auth" />;
  const copy = COPY[mode];

  return (
    <div class="auth">
      <BackgroundLayer module={cfg.background.module} dim={cfg.background.dim} blur={cfg.background.blur} />
      <div class="auth-center">
        <div class={`auth-head ${focused && value ? "soft" : ""}`}>
          <img src="/icons/mark.png" width={40} height={36} alt="" style={{ marginBottom: 18 }} />
          <h1>{pending ? "You're on the list" : copy.title}</h1>
          <p>{pending ? "Thanks. An admin needs to approve your account; you can sign in after that." : copy.sub}</p>
        </div>

        {!pending && (
          <form class="pill" onSubmit={next} noValidate>
            {step > 0 && (
              <button type="button" class="pill-back" aria-label="Back" onClick={() => { setStep(step - 1); setErr(""); }}>
                <Icon name="solar:alt-arrow-left-linear" size={16} />
              </button>
            )}
            {/* Keep the email in the form for password managers on the password step */}
            {cur.key === "password" && <input type="email" value={vals.email} autoComplete="username" hidden readOnly />}
            <input
              key={mode + cur.key}
              ref={input}
              class="pill-input"
              type={cur.type}
              name={cur.key}
              placeholder={cur.placeholder}
              autoComplete={cur.autoComplete}
              autoCapitalize={cur.key === "code" ? "characters" : "off"}
              spellcheck={false}
              value={value}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onInput={(e) => { setVals({ ...vals, [cur.key]: e.currentTarget.value }); setErr(""); }}
            />
            <button class="pill-go" aria-label={step < steps.length - 1 ? "Continue" : mode === "login" ? "Sign in" : mode === "forgot" ? "Get a code" : mode === "reset" ? "Set new password" : "Create account"} disabled={busy}>
              {busy ? <span class="spin" /> : <Icon name="solar:arrow-right-linear" size={16} />}
            </button>
          </form>
        )}

        <div class="auth-meta">
          {err ? <span class="err-text">{err}</span>
            : step > 0 && !pending ? <span class="dim">{vals.email || vals.name}</span>
            : <span>&nbsp;</span>}
        </div>
      </div>

      <footer class="auth-foot">
        {mode === "setup" ? <span class="dim">Only shown until the first account exists.</span>
          : pending ? <span>Back to <button class="link" onClick={() => switchMode("login")}>sign in</button>.</span>
          : mode === "forgot" || mode === "reset"
            ? <span>Remembered it? <button class="link" onClick={() => switchMode("login")}>Sign in</button>.{mode === "reset" && <> No code? <button class="link" onClick={() => switchMode("forgot")}>Send another</button>.</>}</span>
          : mode === "login"
            ? <span>
                {cfg.allowSignup ? <>Don't have an account yet? <button class="link" onClick={() => switchMode("signup")}>Sign up</button>.</>
                  : <span class="dim">Need an account? Ask the admin of this server.</span>}
                <span class="dim" style={{ margin: "0 10px" }}>·</span>
                <button class="link" onClick={() => switchMode("forgot")}>Forgot password?</button>
              </span>
            : <span>Already have an account? <button class="link" onClick={() => switchMode("login")}>Sign in</button>.</span>}
      </footer>
    </div>
  );
}
