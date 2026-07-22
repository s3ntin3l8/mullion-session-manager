import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AuthStatus } from "./api.js";
import { App } from "./App.js";

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
    return <Login methods={status!.methods} onLoggedIn={() => setState("authenticated")} />;
  }
  return (
    <>
      {status?.user && <IdentityBadge user={status.user} />}
      <App />
    </>
  );
}

/** A small, unobtrusive corner badge — only rendered once an OIDC session carries an identity to show. */
function IdentityBadge({ user }: { user: NonNullable<AuthStatus["user"]> }) {
  const [signingOut, setSigningOut] = useState(false);

  return (
    <div
      style={{
        position: "fixed",
        bottom: 8,
        right: 8,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 8px",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--border-soft)",
        fontSize: 12,
        color: "var(--muted)",
      }}
    >
      <span title={user.email ?? user.sub}>{user.name ?? user.email ?? user.sub}</span>
      <button
        className="mono"
        style={{
          all: "unset",
          cursor: "pointer",
          textDecoration: "underline",
        }}
        disabled={signingOut}
        onClick={() => {
          setSigningOut(true);
          void api.logout().finally(() => window.location.reload());
        }}
      >
        Sign out
      </button>
    </div>
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
    // Reuses CreateHostModal's create-modal-* shell for a consistent look —
    // there's no dashboard mounted behind this to dim, so the backdrop's
    // own centering/padding just becomes this screen's layout.
    <div className="create-modal-backdrop">
      <div className="create-modal">
        <div className="create-modal-header">
          <span className="create-modal-header-text">
            <span className="create-modal-title">Sign in</span>
            <span className="create-modal-subtitle">This Mullion instance requires sign-in.</span>
          </span>
        </div>

        <div className="create-modal-body">
          {methods.oidc && (
            // Full-page navigation, not a fetch — the OIDC redirect chain
            // (this app -> provider -> back to /api/auth/oidc/callback) is a
            // real browser navigation, not something an SPA can do via XHR.
            <a
              href="/api/auth/oidc/login"
              className="create-modal-submit"
              style={{ textAlign: "center" }}
            >
              Sign in with SSO
            </a>
          )}

          {methods.oidc && methods.token && (
            <div style={{ fontSize: 12, color: "var(--muted)", textAlign: "center" }}>or</div>
          )}

          {methods.token && (
            <label className="create-modal-field">
              <span className="create-modal-field-label">Access token</span>
              <span className="create-modal-input-row">
                <input
                  ref={inputRef}
                  className="mono"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                  }}
                />
              </span>
            </label>
          )}

          {error && (
            <div style={{ fontSize: 12, color: "var(--r)" }} role="alert">
              {error}
            </div>
          )}
        </div>

        {methods.token && (
          <div className="create-modal-footer">
            <span className="create-modal-footer-hint">
              Matches this server's MULLION_AUTH_TOKEN.
            </span>
            <button className="create-modal-submit" onClick={submit} disabled={submitting}>
              Sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
