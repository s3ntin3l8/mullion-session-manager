// `mullion browser <action>` subcommands, split out of core.mjs (which has a
// size ceiling). core.mjs owns the arg parsing and request plumbing and hands
// them in, so nothing here imports core.mjs back (a cycle would hit the
// temporal dead zone at module evaluation).

/**
 * @param {{
 *   BROWSER_ACTIONS: Record<string, unknown>,
 *   parseBrowserArgs: (action: string, args: string[]) => { body: any, cliFlags: any },
 *   formatBrowserResult: (action: string, result: any) => string,
 *   withSessionId: (body: any, opts: any) => any,
 *   requestOwnSessionFallback: (...args: any[]) => Promise<any>,
 *   CliUsageError: new (message: string) => Error,
 * }} deps
 */
export function buildBrowserCommands(deps) {
  const {
    BROWSER_ACTIONS,
    parseBrowserArgs,
    formatBrowserResult,
    withSessionId,
    requestOwnSessionFallback,
    CliUsageError,
  } = deps;
  const browserCommands = {};
  for (const action of Object.keys(BROWSER_ACTIONS)) {
    browserCommands[action] = async (client, args, opts, io) => {
      const { body, cliFlags } = parseBrowserArgs(action, args);
      const op = body.by !== undefined ? "browser.find" : "browser.action";
      const requestBody = withSessionId(body, opts);
      const result =
        opts.session !== undefined
          ? await client.request(op, requestBody)
          : await requestOwnSessionFallback(
              client,
              op,
              requestBody,
              io,
              "'sessionId' is required",
              (ownId) => ({ ...requestBody, sessionId: ownId }),
            );
      // `json: result` carries the raw response through even on this branch —
      // not just `{screenshot}` — so a future field the server adds to the
      // screenshot response isn't silently dropped from `--json` output.
      if (action === "screenshot")
        return { screenshot: result.screenshot, outPath: cliFlags.out, json: result };
      // Issue #381 (3.10) — reuses that exact same write path: runCommand's
      // `outcome.screenshot`/`outcome.outPath` branch decodes base64 and
      // writes it to disk. `screenshot` here just names that shared "binary
      // payload to write out" channel, not the screenshot action itself — the
      // download response has no `screenshot` field of its own.
      if (action === "download" && cliFlags.out !== undefined) {
        const first = result.downloads?.[0];
        if (!first) throw new CliUsageError("no downloads available to write to --out");
        if (first.contents === undefined) {
          throw new CliUsageError(
            "download response has no 'contents' field to write (did the file exceed --max-bytes?)",
          );
        }
        return { screenshot: first.contents, outPath: cliFlags.out, json: result };
      }
      return { json: result, text: formatBrowserResult(action, result) };
    };
  }

  // `mullion browser unbind`: the way out of a "binding unavailable" browser (its
  // checkout or host is gone) — drops the session's binding so the next browser
  // call resolves the session's current host and checkout.
  browserCommands.unbind = async (client, args, opts, io) => {
    if (args.length > 0) throw new CliUsageError("browser unbind takes no arguments");
    const body = withSessionId({}, opts);
    const result =
      opts.session !== undefined
        ? await client.request("browser.unbind", body)
        : await requestOwnSessionFallback(
            client,
            "browser.unbind",
            body,
            io,
            "'sessionId' is required",
            (ownId) => ({ ...body, sessionId: ownId }),
          );
    const text =
      result.unbound > 0
        ? "Browser unbound; the next browser command re-binds to the session's current host and checkout."
        : "This session had no browser binding.";
    return { json: result, text };
  };

  return browserCommands;
}
