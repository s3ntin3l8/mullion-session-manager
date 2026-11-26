// mcode caps command hooks at 10s, below the Stop retry bound. Hand the
// COMPLETE delivery to a worker before making any attempt, so hook-runner
// timeouts cannot cut the retry short. Credentials travel over IPC, never
// argv or a temporary file. This remains in the session's systemd scope.
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { deliverStop } from "./forwarder-delivery.mjs";

export function startBackgroundStop(socketPath, token, messages) {
  return new Promise((resolve) => {
    // The mcode Stop command uses `exec`, and its shim execs node, so the
    // parent is the agent itself, not an intermediate short-lived shell.
    const ownerPid = process.ppid;
    const worker = fork(new URL(import.meta.url), ["--stop-worker"], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      execArgv: [],
    });
    worker.on("error", () => resolve(false));
    worker.send({ socketPath, token, messages, ownerPid, deliveryId: randomUUID() }, (error) => {
      if (worker.connected) worker.disconnect();
      worker.unref();
      resolve(!error);
    });
  });
}

// Exported for in-process tests against a real socket, as with deliverStop.
export async function runBackgroundStop({ socketPath, token, messages, ownerPid, deliveryId }) {
  // A detached worker must not keep delivering after the agent/session
  // has gone. Check during backoff AND during a socket attempt. Exiting
  // this standalone worker releases both timers and sockets immediately.
  const checkOwner = () => {
    try {
      if (!Number.isInteger(ownerPid) || ownerPid <= 1) process.exit(0);
      process.kill(ownerPid, 0);
    } catch {
      process.exit(0);
    }
  };
  checkOwner();
  const monitor = setInterval(checkOwner, 250);
  try {
    await deliverStop(socketPath, token, messages, deliveryId);
  } finally {
    clearInterval(monitor);
  }
}

if (process.argv[2] === "--stop-worker") {
  process.once("message", runBackgroundStop);
}
