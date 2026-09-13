import { useState } from "react";
import { api } from "../../api/index.js";
import { useAuthStatus } from "../../authContext.js";
import { Eyebrow, SecondaryButton } from "../../ui/primitives.js";

const METHOD_LABELS = {
  authentik: "Authentik gateway",
  gateway: "Trusted gateway",
  oidc: "Mullion OIDC",
  token: "Shared access token",
  none: "No in-process authentication",
} as const;

export function AccountSection() {
  const status = useAuthStatus();
  const [signingOut, setSigningOut] = useState(false);

  if (!status) return <div className="settings-readonly-value">Account details unavailable.</div>;

  const hasIdentityDetails = Boolean(
    status.user?.name || status.user?.username || status.user?.email,
  );
  const gatewayIdentityUnavailable =
    (status.authSource === "gateway" || status.authSource === "authentik") && !hasIdentityDetails;

  const signOut = () => {
    setSigningOut(true);
    void api.logout().finally(() => {
      if (status.logout.kind === "gateway") window.location.assign(status.logout.url);
      else window.location.reload();
    });
  };

  return (
    <>
      <Eyebrow title="Account" desc="Identity supplied by your configured authentication layer." />
      {gatewayIdentityUnavailable && (
        <div className="settings-footer-note">Gateway identity details unavailable.</div>
      )}
      <div className="settings-info-table">
        {status.user?.name && (
          <div className="settings-info-row zebra">
            <span className="settings-info-key">Display name</span>
            <span className="settings-info-value">{status.user.name}</span>
          </div>
        )}
        {status.user?.username && (
          <div className="settings-info-row">
            <span className="settings-info-key">Username</span>
            <span className="settings-info-value">{status.user.username}</span>
          </div>
        )}
        {status.user?.email && (
          <div className="settings-info-row zebra">
            <span className="settings-info-key">Email</span>
            <span className="settings-info-value">{status.user.email}</span>
          </div>
        )}
        <div className="settings-info-row">
          <span className="settings-info-key">Authentication</span>
          <span className="settings-info-value">{METHOD_LABELS[status.authSource]}</span>
        </div>
      </div>
      {status.logout.kind === "local" && (
        <div className="settings-footer-note">
          Sign out clears this browser’s Mullion session only; it does not sign you out of your
          identity provider.
        </div>
      )}
      {status.logout.kind === "gateway" && (
        <div className="settings-footer-note">
          Sign out clears the Mullion session, then signs out through the gateway. Authentik may
          sign you out of every application served by the same outpost.
        </div>
      )}
      {status.logout.kind !== "unavailable" && (
        <div style={{ marginTop: 14 }}>
          <SecondaryButton onClick={signOut} disabled={signingOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </SecondaryButton>
        </div>
      )}
    </>
  );
}
