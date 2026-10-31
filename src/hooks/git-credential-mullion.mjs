#!/usr/bin/env node
// Mullion's git credential helper and `gh` token fetcher (issue #2246),
// invoked as:
//
//   node git-credential-mullion.mjs get|store|erase   (git, via credential.helper)
//   node git-credential-mullion.mjs gh-token          (the bin/gh wrapper)
//
// The token is asked of the host's own Mullion over this session's hook
// socket ($MULLION_HOOK_SOCKET / $MULLION_HOOK_TOKEN) on every call and is
// never stored anywhere. See git-credential-core.mjs for the logic.

import { runCredentialHelper, runGhToken } from "./git-credential-core.mjs";

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

const action = process.argv[2];
const result =
  action === "gh-token"
    ? await runGhToken(process.env)
    : await runCredentialHelper(action, await readStdin(), process.env);
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.code;
