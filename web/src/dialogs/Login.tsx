// Sign in / sign up / first-run setup. One pill-shaped field at a time; the
// heading softly blurs while you type. The background is a replaceable slot
// (Settings → Sign-in screen), "aura" by default.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../lib/ws";
import { BackgroundLayer } from "../shell/Background";
import { Icon } from "../icons/Icon";
import mark from "../assets/mark.png";
import { addPasskey, passkeysAvailable, signInWithPasskey } from "../lib/passkey";

type Mode = "login" | "signup" | "setup" | "forgot" | "reset";
interface Config { needsSetup: boolean; allowSignup: boolean; background: { module: string; dim: number; blur: number }; accent: string }
interface Step { key: "name" | "email" | "password" | "confirm" | "code"; type: string; placeholder: string; autoComplete: string }

const STEPS: Record<Mode, Step[]> = {
  forgot: [
    { key: "email", type: "email", placeholder: "Email address", autoComplete: "username" },
  ],
  reset: [
    { key: "code", type: "text", placeholder: "Reset code, e.g. K7QM-3XRP", autoComplete: "one-time-code" },
    { key: "password", type: "password", placeholder: "New password (8+ characters)", autoComplete: "new-password" },
    { key: "confirm", type: "password", placeholder: "Type the new password again", autoComplete: "new-password" },
  ],
  login: [
    { key: "email", type: "email", placeholder: "Email address", autoComplete: "username" },
    { key: "password", type: "password", placeholder: "Password", autoComplete: "current-password" },
  ],
  signup: [
    { key: "name", type: "text", placeholder: "Your name", autoComplete: "name" },
    { key: "email", type: "email", placeholder: "Email address", autoComplete: "username" },
    { key: "password", type: "password", placeholder: "Choose a password (8+ characters)", autoComplete: "new-password" },
    { key: "confirm", type: "password", placeholder: "Type the password again", autoComplete: "new-password" },
  ],
  setup: [
    { key: "name", type: "text", placeholder: "Your name", autoComplete: "name" },
    { key: "email", type: "email", placeholder: "Email address", autoComplete: "username" },
    { key: "password", type: "password", placeholder: "Choose a password (8+ characters)", autoComplete: "new-password" },
    { key: "confirm", type: "password", placeholder: "Type the password again", autoComplete: "new-password" },
  ],
};

const COPY: Record<Mode, { title: string; sub: string }> = {
  forgot: { title: "Reset your password", sub: "HarbourOS doesn't send email. It writes a one-time code to the server log instead, or your admin can make one for you in Settings → Users." },
  reset: { title: "Enter your reset code", sub: "On the server, in the folder with docker-compose.yml, run this. The code works once, for 15 minutes." },
  login: { title: "Sign in to HarbourOS", sub: "Your home server, one tab away. Sign in with the account your admin gave you." },
  signup: { title: "Create your account", sub: "An admin approves new accounts before you can sign in." },
  setup: { title: "Set up HarbourOS", sub: "Create the first account. It becomes the admin for this server." },
};

export function Login({ onDone }: { onDone: () => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [mode, setMode] = useState<Mode>("login");
  const [step, setStep] = useState(0);
  const [vals, setVals] = useState({ name: "", email: "", password: "", confirm: "", code: "" });
  const [show, setShow] = useState(false);
  const [offer, setOffer] = useState(false); // after the first sign-up: add a passkey?
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

  const switchMode = (m: Mode) => { setMode(m); setStep(0); setErr(""); setPending(false); setVals((v) => ({ ...v, password: "", confirm: "", code: "" })); setShow(false); };

  const canPasskey = passkeysAvailable();
  const passkey = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    try { if (await signInWithPasskey()) onDone(); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };

  const next = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (cur.key === "name" && !value.trim()) return setErr("Enter your name.");
    if (cur.key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return setErr("Enter a valid email address.");
    if (cur.key === "password" && !value) return setErr("Enter your password.");
    if (cur.key === "code" && value.replace(/[^a-z0-9]/gi, "").length !== 8) return setErr("The code has 8 letters and digits.");
    if (cur.key === "password" && mode !== "login" && value.length < 8) return setErr("Use at least 8 characters.");
    if (cur.key === "confirm" && value !== vals.password) { setVals((v) => ({ ...v, confirm: "" })); return setErr("The passwords don't match. Type it again, or go back to change it."); }
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
        if (r.pending) { setPending(true); setVals({ name: "", email: "", password: "", confirm: "", code: "" }); }
        else if (passkeysAvailable()) setOffer(true);
        else onDone();
      }
    } catch (x) {
      setErr((x as Error).message);
      if (cur.key === "password" && mode === "login") setVals((v) => ({ ...v, password: "" }));
    } finally { setBusy(false); }
  };

  if (!cfg) return <div class="auth" />;
  if (offer) return <PasskeyOffer background={cfg.background} onDone={onDone} />;
  const copy = COPY[mode];

  return (
    <div class="auth">
      <BackgroundLayer module={cfg.background.module} dim={cfg.background.dim} blur={cfg.background.blur} />
      <div class="auth-center">
        <div class={`auth-head ${focused && value ? "soft" : ""}`}>
          <img src={mark} width={40} height={36} alt="" style={{ marginBottom: 18 }} />
          <h1>{pending ? "You're on the list" : copy.title}</h1>
          <p>{pending ? "Thanks. An admin needs to approve your account; you can sign in after that." : copy.sub}</p>
        </div>

        {mode === "reset" && !pending && <ResetCommand />}

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
              type={cur.type === "password" && show ? "text" : cur.type}
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
            {cur.type === "password" && (
              <button type="button" class="pill-eye" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show}
                onMouseDown={(e) => e.preventDefault()} onClick={() => setShow(!show)}>
                <Icon name={show ? "solar:eye-closed-linear" : "solar:eye-linear"} size={18} />
              </button>
            )}
            <button class="pill-go" aria-label={step < steps.length - 1 ? "Continue" : mode === "login" ? "Sign in" : mode === "forgot" ? "Get a code" : mode === "reset" ? "Set new password" : "Create account"} disabled={busy}>
              {busy ? <span class="spin" /> : <Icon name="solar:arrow-right-linear" size={16} />}
            </button>
          </form>
        )}

        {mode === "login" && step === 0 && canPasskey && !pending && (
          <button type="button" class="passkey-btn" onClick={passkey} disabled={busy}>
            <Icon name="solar:key-minimalistic-square-linear" size={18} />Sign in with a passkey
          </button>
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

const RESET_CMD = 'docker compose logs harbor | grep -A2 "password reset"';

/** The command that shows the reset code, big enough to read and one tap to copy. */
function ResetCommand() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    // navigator.clipboard needs https or localhost; fall back to a hidden textarea on plain http.
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1800); };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(RESET_CMD).then(done).catch(() => {}); return; }
    const t = Object.assign(document.createElement("textarea"), { value: RESET_CMD });
    t.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); done(); } finally { t.remove(); }
  };
  return (
    <div class="reset-cmd">
      <code><span class="dim">$ </span>{RESET_CMD}</code>
      <button type="button" class="reset-copy" onClick={copy} aria-label="Copy the command">
        <Icon name={copied ? "solar:check-circle-linear" : "solar:copy-linear"} size={16} />{copied ? "Copied" : "Copy"}
      </button>
      <div class="reset-hint">Look for <b>Code: XXXX-XXXX</b> in the output.</div>
    </div>
  );
}

/** Right after the first account is made: one tap to add a passkey, or skip. */
function PasskeyOffer({ background, onDone }: { background: Config["background"]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const add = async () => {
    setBusy(true); setErr("");
    try { if (await addPasskey()) onDone(); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div class="auth">
      <BackgroundLayer module={background.module} dim={background.dim} blur={background.blur} />
      <div class="auth-center">
        <div class="auth-head">
          <Icon name="solar:key-minimalistic-square-linear" size={40} />
          <h1 style={{ marginTop: 14 }}>Add a passkey?</h1>
          <p>Next time, sign in with Face ID, Touch ID or Windows Hello instead of typing your password. You can add more later in Settings → Passkeys.</p>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 22 }}>
          <button type="button" class="passkey-btn primary" onClick={add} disabled={busy}>
            {busy ? <span class="spin" /> : <Icon name="solar:key-minimalistic-square-linear" size={18} />}Add a passkey
          </button>
          <button type="button" class="passkey-btn" onClick={onDone} disabled={busy}>Not now</button>
        </div>
        <div class="auth-meta">{err ? <span class="err-text">{err}</span> : <span>&nbsp;</span>}</div>
      </div>
    </div>
  );
}
