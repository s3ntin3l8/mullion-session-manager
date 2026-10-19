/**
 * Runs `run(browser, demo, signal)` against a freshly started demo and always
 * tears the demo down afterwards: when the browser fails to launch (e.g.
 * Playwright's browser isn't installed), when `run` throws, and on
 * SIGINT/SIGTERM.
 *
 * startDemo() cleans up after itself only while it is starting; once it has
 * returned, its servers run in their own process groups and its sessions in
 * systemd scopes, so anything that ends this process without `demo.stop()`
 * (an uncaught launch failure, Ctrl-C) leaves them running on the demo ports.
 *
 * `signal` aborts when the run is interrupted or the demo is being torn down;
 * `run` should stop polling on it, or an abandoned step keeps the process
 * alive after teardown. The signal handlers stay installed until the demo has
 * stopped, so a second Ctrl-C during the (slow) teardown can't kill the
 * process halfway through it.
 *
 * `signals` is the event target for SIGINT/SIGTERM (process, or a stub in tests).
 */
export async function withDemo({
  startDemo,
  launchBrowser,
  run,
  signals = process,
  lateLaunchMs = 10_000,
}) {
  const demo = await startDemo();
  const aborted = new AbortController();
  let interrupt;
  const interrupted = new Promise((_, reject) => (interrupt = reject));
  interrupted.catch(() => {});
  const onSignal = (signal) => {
    if (aborted.signal.aborted) return console.warn(`[demo] ${signal}: still tearing down...`);
    const err = new Error(`interrupted by ${signal}`);
    aborted.abort(err);
    interrupt(err);
  };
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);

  let browser;
  const launching = Promise.resolve().then(launchBrowser);
  launching.catch(() => {});
  try {
    browser = await Promise.race([launching, interrupted]);
    return await Promise.race([run(browser, demo, aborted.signal), interrupted]);
  } finally {
    if (!aborted.signal.aborted) aborted.abort(new Error("demo is being torn down"));
    // Interrupted mid-launch: wait (bounded) for the launch to land so the
    // browser can't outlive this process.
    browser ??= await settledWithin(launching, lateLaunchMs);
    if (browser) await closeQuietly(browser);
    console.log("[demo] tearing down the demo...");
    try {
      await demo.stop();
    } finally {
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
    }
  }
}

/** The value `promise` resolves to within `ms`, or undefined. */
async function settledWithin(promise, ms) {
  let timer;
  const timeout = new Promise((r) => (timer = setTimeout(r, ms)));
  try {
    return await Promise.race([promise.catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function closeQuietly(browser) {
  try {
    await browser.close();
  } catch (err) {
    console.warn(`[demo] closing the browser failed: ${err}`);
  }
}
