import { Buffer } from "node:buffer";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const here = path.dirname(fileURLToPath(import.meta.url));
const protoPath = path.resolve(here, "../../../src/services/device-drivers/idb/idb.proto");

function parseArgs(argv) {
  let udid = "";
  let port = 0;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--udid" && i + 1 < argv.length) {
      udid = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--grpc-port" && i + 1 < argv.length) {
      port = Number(argv[i + 1]);
      i += 1;
    }
  }
  return { udid, port };
}

const { udid, port } = parseArgs(process.argv.slice(2));
const mode = process.env.FAKE_IDB_MODE ?? "normal";

if (!udid || !Number.isInteger(port) || port <= 0) {
  process.stderr.write(`invalid args: udid=${udid} port=${port}\n`);
  process.exit(2);
}

const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: false,
  oneofs: true,
});
const loaded = grpc.loadPackageDefinition(packageDefinition);
const CompanionService = loaded.idb.CompanionService;

let crashScheduled = false;
const server = new grpc.Server();
server.addService(CompanionService.service, {
  describe(_call, callback) {
    if (mode === "hang-describe") {
      // Intentionally never reply to test readiness timeout.
      return;
    }
    callback(null, {
      target_description: {
        udid,
        name: "iPhone 17 (Fake)",
        state: "Booted",
        target_type: "simulator",
        os_version: "iOS 26.5",
        architecture: "arm64",
        screen_dimensions: {
          width: 1206,
          height: 2622,
          density: 3.0,
          width_points: 402,
          height_points: 874,
        },
      },
    });
    if (mode === "exit-after-ready" && !crashScheduled) {
      crashScheduled = true;
      const delayMs = Number(process.env.FAKE_IDB_EXIT_MS ?? "50");
      setTimeout(() => {
        process.stderr.write("simulated crash\n");
        server.forceShutdown();
        process.exit(42);
      }, delayMs);
    }
  },
  hid(call, callback) {
    call.on("data", () => undefined);
    call.on("end", () => callback(null, {}));
  },
  video_stream(call) {
    call.on("data", (req) => {
      if (req.start) {
        call.write({
          payload: {
            data: Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67]),
          },
        });
      } else if (req.stop) {
        call.end();
      }
    });
  },
});

if (mode === "ignore-sigterm") {
  process.on("SIGTERM", () => {
    process.stderr.write("ignoring SIGTERM\n");
  });
} else {
  process.on("SIGTERM", () => {
    server.forceShutdown();
    process.exit(0);
  });
}

server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
  if (err) {
    process.stderr.write(`bind failed: ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`fake idb_companion listening on 127.0.0.1:${port}\n`);
});
