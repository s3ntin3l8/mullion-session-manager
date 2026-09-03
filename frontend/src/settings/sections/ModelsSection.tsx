import { useEffect, useState } from "react";
import { useDashboardStore } from "../../store/index.js";
import { api } from "../../api/index.js";
import { Row } from "../../ui/primitives.js";

type CatalogStatus = "loading" | "ready" | "error";

export function ModelsSection() {
  const { settings, updateSettings } = useDashboardStore();
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<CatalogStatus>("loading");

  useEffect(() => {
    api
      .listOpenCodeModels()
      .then((list) => {
        // Defense in depth alongside the route fix (src/routes/opencode-models.ts)
        // — the ErrorBoundary wrapping the whole Settings dialog (App.tsx) means
        // a malformed response here would otherwise lock the user out of every
        // settings section, not just this one.
        setModels(Array.isArray(list) ? list : []);
        setStatus("ready");
      })
      .catch(() => setStatus("error"));
  }, []);

  const implementerValue = settings.opencode?.implementerModel ?? "";
  const reviewerValue = settings.opencode?.reviewerModel ?? "";
  const smallModelValue = settings.opencode?.defaultSmallModel ?? "";

  const handleChange = (
    key: "implementerModel" | "reviewerModel" | "defaultSmallModel",
    value: string,
  ) => {
    updateSettings({
      opencode: { [key]: value || null },
    });
  };

  return (
    <>
      <Row label="Implementer model" desc="Default model for task worker sessions.">
        <select
          className="settings-select"
          value={implementerValue}
          onChange={(e) => handleChange("implementerModel", e.target.value)}
        >
          <option value="">— None (CLI default) —</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Reviewer model" desc="Default model for task review-agent sessions.">
        <select
          className="settings-select"
          value={reviewerValue}
          onChange={(e) => handleChange("reviewerModel", e.target.value)}
        >
          <option value="">— None (CLI default) —</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Small model" desc="Used for lightweight tasks like title generation.">
        <select
          className="settings-select"
          value={smallModelValue}
          onChange={(e) => handleChange("defaultSmallModel", e.target.value)}
        >
          <option value="">— None (CLI default) —</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </Row>
      <p
        style={{
          fontSize: 12,
          color: "var(--muted)",
          margin: "4px 0 0",
          paddingLeft: 6,
        }}
      >
        {status === "error"
          ? // Reached only for a genuine HTTP/network failure fetching
            // GET /api/opencode/models — NOT for "opencode isn't installed."
            // src/services/opencode-models.ts's listOpenCodeModels() catches
            // every exec failure internally, including ENOENT when
            // `opencode` isn't on PATH, and returns [] rather than
            // throwing — so the route still responds 200 [] for that case,
            // landing in the "ready && empty" branch below, not here.
            // (Code review caught the two messages swapped relative to
            // this.)
            "Couldn't load the model catalog — try reopening Settings."
          : status === "ready" && models.length === 0
            ? // Covers BOTH real causes that land here: opencode isn't
              // installed (the common case — see the note above) and
              // opencode is installed but has no configured provider.
              "opencode returned no models — check that it's installed and has a configured provider."
            : // These apply to opencode sessions only; other agents (claude,
              // codex, agy) ignore them entirely — no need to gate the
              // selects on the install's default agent (issue #957's
              // backend resolution already keys off the session's actual
              // command, via commandIsOpencode(), not this setting).
              "Applies to opencode sessions only. Each can be overridden per task via Model: / Reviewer-Model: / SmallModel: lines in the task issue body."}
      </p>
    </>
  );
}
