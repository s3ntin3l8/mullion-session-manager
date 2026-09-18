import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AuthStatus } from "./api/index.js";
import { App } from "./App.js";
import { MullionMark } from "./assets/MullionMark.js";
import { readThemeHint, systemPrefersDark } from "./store/helpers.js";
import { ErrorText } from "./ui/ErrorText.js";
import { AuthStatusContext } from "./authContext.js";

type GateState = "loading" | "unauthenticated" | "authenticated";

/**
 * Wraps <App/> (the actual dashboard) so its data-fetching effects — which
 * fire unconditionally on mount and would otherwise flood the console with
 * 401s — never run until we know whether a session is required. GET
 * /api/auth/me is the one endpoint reachable regardless of auth state (see
 * src/plugins/auth.ts's own /api/auth/ prefix exemption — a request can't
 * authenticate itself against a gate that also blocks the endpoint that
 * authenticates it), so it's safe to call before anything else mounts.
 *
 * With neither MULLION_AUTH_TOKEN nor MULLION_OIDC_* set (the default),
 * methods.token and methods.oidc are both false and this renders <App/>
 * immediately — identical to before this feature existed.
 */
export function AuthGate() {
  const [state, setState] = useState<GateState>("loading");
  const [status, setStatus] = useState<AuthStatus | null>(null);

  const checkStatus = () => {
    return api
      .getAuthStatus()
      .then((s) => {
        setStatus(s);
        const authRequired = s.methods.token || s.methods.oidc;
        setState(!authRequired || s.authenticated ? "authenticated" : "unauthenticated");
      })
      .catch(() => {
        // Backend unreachable (not a 401 — request() only throws ApiError
        // for a non-ok response, and a network failure throws something
        // else entirely). Fall through to <App/>, which already has its own
        // "Mullion server unreachable" banner (store.ts's live-refresh
        // poll) — a login screen here would just hide that behind a second,
        // less informative failure mode.
        setState("authenticated");
      });
  };

  useEffect(() => {
    void checkStatus();
  }, []);

  if (state === "loading") return null;
  if (state === "unauthenticated") {
    // Only the token form below ever calls onLoggedIn — OIDC login is a
    // full-page navigation to /api/auth/oidc/login, and its callback
    // redirects back to "/", which remounts AuthGate and re-fetches GET
    // /api/auth/me from scratch (picking up `user`, if any, then). No
    // client-side re-fetch is needed here, and a token login never carries
    // an identity to populate a badge with anyway.
    return <Login methods={status!.methods} onLoggedIn={() => void checkStatus()} />;
  }
  return (
    <AuthStatusContext.Provider value={status}>
      <App />
    </AuthStatusContext.Provider>
  );
}

function Login({
  methods,
  onLoggedIn,
}: {
  methods: AuthStatus["methods"];
  onLoggedIn: () => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (methods.token) inputRef.current?.focus();
  }, [methods.token]);

  // Resolved once per mount, not reactively — there's no store/context to
  // subscribe to yet (that's the whole reason AuthGate exists: App, and the
  // theme state that lives inside it, hasn't mounted). A user who flips their
  // OS theme while sitting on this exact screen won't see it update live;
  // they will on next reload, same as any other "system" preference before
  // the dashboard's own watcher (slices/ui.ts) takes over.
  const [theme] = useState(() => readThemeHint(systemPrefersDark() ? "dark" : "light"));

  const submit = () => {
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Enter your access token.");
      return;
    }
    setSubmitting(true);
    setError(null);
    void api
      .login(trimmed)
      .then(onLoggedIn)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.statusCode === 401
            ? "Invalid token."
            : "Could not sign in.",
        );
        setSubmitting(false);
      });
  };

  return (
    // `cmux-root`/`light` re-applied here the same way portaled surfaces do
    // it (ui/KebabMenu.tsx, NotificationBell.tsx's overflow panel) — this
    // renders instead of <App/>, outside the element that normally carries
    // those classes, so none of tokens.css's custom properties (--chrome,
    // --accent-solid, --muted, ...) would otherwise resolve at all.
    <div className={`login-root cmux-root${theme === "light" ? " light" : ""}`}>
      <div className="login-brand">
        <MullionMark size={26} />
        <span className="login-wordmark">Mullion</span>
      </div>

      <div className="login-card">
        <h1 className="login-title">Sign in</h1>
        <p className="login-subtitle">This Mullion instance requires sign-in.</p>

        {methods.oidc && (
          // Full-page navigation, not a fetch — the OIDC redirect chain
          // (this app -> provider -> back to /api/auth/oidc/callback) is a
          // real browser navigation, not something an SPA can do via XHR.
          // Stays an <a>, not a <button> — AuthGate.test.tsx asserts
          // role="link" with this exact href.
          <a href="/api/auth/oidc/login" className="login-btn">
            Sign in with SSO
          </a>
        )}

        {methods.oidc && methods.token && <div className="login-divider">or</div>}

        {methods.token && (
          <form
            className="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <label className="login-field">
              <span className="login-field-label">Access token</span>
              <span className="login-input-row">
                <input
                  ref={inputRef}
                  className="mono"
                  type="password"
                  autoComplete="current-password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </span>
            </label>

            {error && <ErrorText>{error}</ErrorText>}

            <button type="submit" className="login-btn" disabled={submitting}>
              Sign in
            </button>
            <span className="login-hint">Matches this server's MULLION_AUTH_TOKEN.</span>
          </form>
        )}
      </div>
    </div>
  );
}
