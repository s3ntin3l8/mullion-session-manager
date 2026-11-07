import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import http from "node:http";
import net from "node:net";
import { relayFetchResponse } from "../../src/services/http-proxy.js";

// relayFetchResponse chunks a body that has no content-length so an aborted
// body is distinguishable from a finished one. Chunk framing is HTTP/1.1; a
// 1.0 client must get the connection-delimited body it can actually parse.
describe("relayFetchResponse framing", () => {
  const closers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
  });

  async function relayServer(): Promise<number> {
    const app = Fastify();
    app.get("/*", async (request, reply) =>
      relayFetchResponse(reply, request.method, new Response("hello"), null),
    );
    await app.listen({ port: 0, host: "127.0.0.1" });
    closers.push(() => app.close());
    return (app.server.address() as { port: number }).port;
  }

  it("chunks the body for an HTTP/1.1 client", async () => {
    const port = await relayServer();
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/" }, (res) => {
          res.resume();
          res.on("end", () => resolve(res.headers));
        })
        .on("error", reject);
    });
    expect(headers["transfer-encoding"]).toBe("chunked");
  });

  it("does not chunk the body for an HTTP/1.0 client", async () => {
    const port = await relayServer();
    const raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write("GET / HTTP/1.0\r\nHost: x\r\n\r\n");
      });
      socket.on("data", (c) => chunks.push(Buffer.from(c)));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
      socket.on("error", reject);
    });
    const [head, body] = raw.split("\r\n\r\n");
    expect(head.toLowerCase()).not.toContain("transfer-encoding");
    expect(body).toBe("hello");
  });
});
