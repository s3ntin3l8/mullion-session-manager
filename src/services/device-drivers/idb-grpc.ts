import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export const IDB_PROTO_PATH = fileURLToPath(new URL("./idb/idb.proto", import.meta.url));

export interface IdbPoint {
  x: number;
  y: number;
}

export interface IdbPayload {
  file_path?: string;
  data?: Buffer | Uint8Array;
  url?: string;
  compression?: "GZIP" | "ZSTD";
  source?: "file_path" | "data" | "url" | "compression";
}

export type IdbVideoFormat = "H264" | "RBGA" | "MJPEG" | "MINICAP" | "I420";

export interface IdbVideoStreamStart {
  file_path?: string;
  fps?: number;
  format?: IdbVideoFormat;
  compression_quality?: number;
  scale_factor?: number;
  avg_bitrate?: number;
  key_frame_rate?: number;
}

export interface IdbVideoStreamRequest {
  start?: IdbVideoStreamStart;
  stop?: Record<string, never>;
  control?: "start" | "stop";
}

export interface IdbVideoStreamResponse {
  log_output?: Buffer;
  payload?: IdbPayload;
  output?: "log_output" | "payload";
}

export type IdbHidDirection = "DOWN" | "UP";

export type IdbHidButtonType =
  | "APPLE_PAY"
  | "HOME"
  | "LOCK"
  | "SIDE_BUTTON"
  | "SIRI"
  | "PLAY_PAUSE"
  | "VOLUME_UP"
  | "VOLUME_DOWN"
  | "EJECT";

export type IdbHidOrientationType =
  "PORTRAIT" | "PORTRAIT_UPSIDE_DOWN" | "LANDSCAPE_LEFT" | "LANDSCAPE_RIGHT";

export interface IdbHidEvent {
  press?: {
    action?: {
      touch?: { point: IdbPoint };
      button?: { button: IdbHidButtonType };
      key?: { keycode: number };
    };
    direction?: IdbHidDirection;
  };
  swipe?: {
    start: IdbPoint;
    end: IdbPoint;
    delta?: number;
    duration?: number;
  };
  delay?: {
    duration: number;
  };
  pinch?: {
    center: IdbPoint;
    scale: number;
    duration?: number;
    radius?: number;
  };
  orientation?: {
    orientation: IdbHidOrientationType;
  };
  shake?: Record<string, never>;
  hinge?: {
    angle: number;
  };
}

export type IdbHidResponse = Record<string, never>;

export interface IdbScreenDimensions {
  width: number;
  height: number;
  density: number;
  width_points: number;
  height_points: number;
}

export interface IdbTargetDescription {
  udid: string;
  name: string;
  screen_dimensions?: IdbScreenDimensions;
  state: string;
  target_type: string;
  os_version: string;
  architecture: string;
  extended?: Buffer;
  diagnostics?: Buffer;
}

export interface IdbTargetDescriptionResponse {
  target_description?: IdbTargetDescription;
}

export interface IdbDescribeOptions {
  timeoutMs?: number;
}

export interface IdbHidOnceOptions {
  timeoutMs?: number;
}

export interface IdbGrpcClient {
  videoStream(
    start: IdbVideoStreamStart,
  ): grpc.ClientDuplexStream<IdbVideoStreamRequest, IdbVideoStreamResponse>;
  hid(): grpc.ClientWritableStream<IdbHidEvent>;
  /** Sends a one-shot HID event batch, half-closes the stream, and awaits
   * the server's completion status so stale-HID errors are observed before
   * returning. */
  hidOnce(events: IdbHidEvent[], options?: IdbHidOnceOptions): Promise<void>;
  describe(options?: IdbDescribeOptions): Promise<IdbTargetDescriptionResponse>;
  close(): void;
}

interface RawCompanionServiceClient extends grpc.Client {
  describe(
    request: { fetch_diagnostics: boolean },
    options: grpc.CallOptions,
    callback: grpc.requestCallback<IdbTargetDescriptionResponse>,
  ): grpc.ClientUnaryCall;
  hid(callback: grpc.requestCallback<IdbHidResponse>): grpc.ClientWritableStream<IdbHidEvent>;
  hid(
    options: grpc.CallOptions,
    callback: grpc.requestCallback<IdbHidResponse>,
  ): grpc.ClientWritableStream<IdbHidEvent>;
  video_stream(): grpc.ClientDuplexStream<IdbVideoStreamRequest, IdbVideoStreamResponse>;
}

type CompanionServiceConstructor = grpc.ServiceClientConstructor & {
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ChannelOptions,
  ): RawCompanionServiceClient;
};

/** Reconnect backoff for the loopback channel. grpc-js backs off
 * exponentially (to 120 s) after a refused connection, and a call made in
 * between fails with UNAVAILABLE without dialing: a companion that comes up
 * late in a cold start would go unseen for tens of seconds (#3527). The peer
 * is a local process, so redialing every second at most costs nothing. */
export const IDB_CHANNEL_OPTIONS: grpc.ChannelOptions = {
  "grpc.initial_reconnect_backoff_ms": 250,
  "grpc.max_reconnect_backoff_ms": 1_000,
};

let cachedCompanionService: CompanionServiceConstructor | null = null;

/** Loads and caches the `idb.CompanionService` gRPC constructor from the
 * vendored `idb.proto` with `keepCase: true`. */
export function loadIdbCompanionService(): CompanionServiceConstructor {
  if (cachedCompanionService) return cachedCompanionService;
  const packageDefinition = protoLoader.loadSync(IDB_PROTO_PATH, {
    keepCase: true,
    longs: Number,
    enums: String,
    defaults: false,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(packageDefinition) as {
    idb?: { CompanionService?: CompanionServiceConstructor };
  };
  const service = loaded.idb?.CompanionService;
  if (!service) {
    throw new Error(`idb.CompanionService not found in ${IDB_PROTO_PATH}`);
  }
  cachedCompanionService = service;
  return service;
}

/** Creates a typed gRPC client for `idb_companion` bound strictly to
 * `127.0.0.1:<port>` over insecure loopback credentials. */
export function createIdbGrpcClient(port: number): IdbGrpcClient {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`invalid idb_companion port: ${String(port)}`);
  }
  const CompanionService = loadIdbCompanionService();
  const client = new CompanionService(
    `127.0.0.1:${port}`,
    grpc.credentials.createInsecure(),
    IDB_CHANNEL_OPTIONS,
  );

  return {
    videoStream(start: IdbVideoStreamStart) {
      const stream = client.video_stream();
      stream.write({ start });
      return stream;
    },

    hid() {
      // grpc-js delivers non-OK server statuses to the client-streaming
      // callback rather than emitting `error` on the writable stream; forward
      // them onto the stream when a listener is attached.
      const stream = client.hid((err: grpc.ServiceError | null) => {
        if (!err) return;
        if (stream.listenerCount("error") > 0) stream.destroy(err);
        else stream.destroy();
      });
      return stream;
    },

    hidOnce(events: IdbHidEvent[], options: IdbHidOnceOptions = {}): Promise<void> {
      const callOptions: grpc.CallOptions = {};
      if (options.timeoutMs !== undefined) {
        callOptions.deadline = Date.now() + options.timeoutMs;
      }
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err?: Error | null) => {
          if (settled) return;
          settled = true;
          if (err) reject(err);
          else resolve();
        };
        const stream = client.hid(callOptions, (err: grpc.ServiceError | null) => {
          finish(err);
        });
        stream.on("error", (err: Error) => finish(err));
        try {
          for (const event of events) {
            stream.write(event);
          }
          stream.end();
        } catch (err) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    describe(options: IdbDescribeOptions = {}): Promise<IdbTargetDescriptionResponse> {
      const callOptions: grpc.CallOptions = {};
      if (options.timeoutMs !== undefined) {
        callOptions.deadline = Date.now() + options.timeoutMs;
      }
      return new Promise((resolve, reject) => {
        client.describe(
          { fetch_diagnostics: false },
          callOptions,
          (err: grpc.ServiceError | null, response?: IdbTargetDescriptionResponse) => {
            if (err) {
              reject(err);
              return;
            }
            resolve(response ?? {});
          },
        );
      });
    },

    close() {
      client.close();
    },
  };
}
