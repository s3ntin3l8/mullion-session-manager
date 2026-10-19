/**
 * Runs `run(browser, demo)` against a freshly started demo and always tears the
 * demo down afterwards: when the browser fails to launch (e.g. Playwright's
 * browser isn't installed), when `run` throws, and on SIGINT/SIGTERM.
 *
 * startDemo() cleans up after itself only while it is starting; once it has
 * returned, its servers run in their own process groups and its sessions in
 * systemd scopes, so anything that ends this process without `demo.stop()`
 * (an uncaught launch failure, Ctrl-C) leaves them running on the demo ports.
 *
 * `signals` is the event target for SIGINT/SIGTERM (process, or a stub in tests).
 */
export async function withDemo({ startDemo, launchBrowser, run, signals = process }) {
  const demo = await startDemo();
  let interrupt;
  const interrupted = new Promise((_, reject) => (interrupt = reject));
  interrupted.catch(() => {});
  const onSignal = (signal) => interrupt(new Error(`interrupted by ${signal}`));
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);

  let browser;
  const launching = Promise.resolve().then(launchBrowser);
  try {
    browser = await Promise.race([launching, interrupted]);
    return await Promise.race([run(browser, demo), interrupted]);
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
    if (browser) await closeQuietly(browser);
    // Interrupted mid-launch: close the browser if the launch still lands.
    else launching.then(closeQuietly, () => {});
    console.log("[demo] tearing down the demo...");
    await demo.stop();
  }
}

async function closeQuietly(browser) {
  try {
    await browser.close();
  } catch (err) {
    console.warn(`[demo] closing the browser failed: ${err}`);
  }
}
