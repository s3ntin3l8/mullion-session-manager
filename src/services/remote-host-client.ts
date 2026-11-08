// The remote host client's public entry point. The class and its types live in
// remote-host-client-core.ts, the per-host cache in remote-host-client-cache.ts
// and the addressing/signing/SSRF-pinning transport in remote-host-transport.ts;
// this façade keeps every importer's path. Nothing here may be imported BACK by
// those modules (issue #2714): the cache imports the class from -core, which is
// what keeps the cycle closed.
export * from "./remote-host-client-core.js";
export { getRemoteHostClient } from "./remote-host-client-cache.js";
