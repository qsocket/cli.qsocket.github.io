import {
  ByteStreamReader,
  bytesToUtf8,
  utf8ToBytes,
} from "./bytes";
import {
  QSocketEncryptedStream,
  QSocketPlainStream,
  type QSocketDataStream,
} from "./encryptedStream";
import {
  resolveQSocketSecret,
  type ResolvedQSocketSecret,
} from "./secret";
import {
  initPtySession,
  type Winsize,
} from "./session";
import { QSocketSrpClient } from "./srp";

export const DEFAULT_QSRN_RELAY = "relay.qsocket.io";
const HANDSHAKE_TIMEOUT_MS = 25_000;

export type ConnectionPhase =
  | "idle"
  | "ws_connecting"
  | "srp_exchange"
  | "e2e_init"
  | "pty_session"
  | "connected"
  | "disconnected"
  | "error";

export interface ProtocolLogEntry {
  id: string;
  timestamp: number;
  level: "info" | "success" | "warn" | "error";
  stage: string;
  message: string;
}

export interface QSocketConnectOptions {
  secretInput: string;
  relayServer?: string;
  e2e?: boolean;
  normalizeSecretUuid?: boolean;
  execCommand?: string;
  getTerminalSize: () => Winsize;
  onPhaseChange: (phase: ConnectionPhase, detail: string) => void;
  onLog: (entry: ProtocolLogEntry) => void;
  onOutput: (data: Uint8Array) => void;
  onStats: (stats: { txBytes: number; rxBytes: number }) => void;
  onSessionEstablished: (meta: SessionMetadata) => void;
  onClose: (reason: string, hadError: boolean) => void;
}

export interface SessionMetadata {
  resolvedSecret: ResolvedQSocketSecret;
  wsUrl: string;
  e2eEnabled: boolean;
  cipherSuite: string;
  sessionKeyFingerprint: string | null;
  initialTermSize: Winsize;
  connectedAt: number;
}

export interface ActiveQSocketConnection {
  sendInput: (data: string | Uint8Array) => void;
  disconnect: () => void;
}

/**
 * Builds the WebSocket QSRN gate URL using `/web-cli` instead of a checksum URI
 * and `?key=<uid>` query parameter instead of Sec-WebSocket-Key.
 */
export function buildQsrnWebCliUrl(
  relayServer: string,
  uidBase64: string
): string {
  const trimmed = (relayServer || DEFAULT_QSRN_RELAY).trim();
  let baseUrl: string;

  if (/^wss?:\/\//i.test(trimmed)) {
    baseUrl = trimmed;
  } else if (/^https?:\/\//i.test(trimmed)) {
    baseUrl = trimmed.replace(/^http/i, "ws");
  } else {
    baseUrl = `wss://${trimmed}`;
  }

  const parsed = new URL(baseUrl);
  parsed.pathname = "/web-cli";
  parsed.search = `?key=${encodeURIComponent(uidBase64)}`;
  parsed.hash = "";
  return parsed.toString();
}

function makeLog(
  level: ProtocolLogEntry["level"],
  stage: string,
  message: string
): ProtocolLogEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    level,
    stage,
    message,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Connects to the live QSocket Relay Network (QSRN) over WebSocket using the exact
 * qsocket-go E2E protocol (SRP-4096 + AES-256-GCM + QS v1 PTY session specs).
 */
export function connectToQSocketRelay(
  opts: QSocketConnectOptions
): ActiveQSocketConnection {
  const e2e = opts.e2e ?? true;
  const normalizeUuid = opts.normalizeSecretUuid ?? true;
  const resolved = resolveQSocketSecret(opts.secretInput, normalizeUuid);
  const wsUrl = buildQsrnWebCliUrl(
    opts.relayServer || DEFAULT_QSRN_RELAY,
    resolved.uidBase64
  );

  const reader = new ByteStreamReader();
  let dataStream: QSocketDataStream | null = null;
  let ws: WebSocket | null = null;
  let closed = false;
  let handshakeComplete = false;
  let txBytes = 0;
  let rxBytes = 0;

  // Preserve strict ordering if any Blob messages ever arrive
  let incomingQueue: Promise<void> = Promise.resolve();

  const reportStats = () => {
    opts.onStats({ txBytes, rxBytes });
  };

  const emitLog = (
    level: ProtocolLogEntry["level"],
    stage: string,
    message: string
  ) => {
    opts.onLog(makeLog(level, stage, message));
  };

  const sendRawBytes = (bytes: Uint8Array) => {
    if (closed || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    txBytes += bytes.byteLength;
    ws.send(bytes);
    reportStats();
  };

  const cleanup = (reason: string, isError: boolean) => {
    if (closed) {
      return;
    }
    closed = true;
    reader.close(new Error(reason));
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try {
        ws.close(1000, "Client closed session");
      } catch {
        // Ignore close errors
      }
    }
    opts.onPhaseChange(isError ? "error" : "disconnected", reason);
    opts.onClose(reason, isError);
  };

  opts.onPhaseChange("ws_connecting", "Dialing QSocket Relay Network (QSRN)...");
  emitLog(
    "info",
    "KNOCK",
    `Resolved secret URI ${resolved.uri} (UID: ${resolved.uidBase64})`
  );
  emitLog("info", "QSRN", `Connecting to ${wsUrl.split("?")[0]}?key=***`);

  try {
    ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid WebSocket relay URL.";
    emitLog("error", "QSRN", msg);
    queueMicrotask(() => cleanup(msg, true));
    return {
      sendInput: () => {},
      disconnect: () => cleanup("Disconnected.", false),
    };
  }

  ws.onmessage = (event: MessageEvent) => {
    if (closed) {
      return;
    }
    if (event.data instanceof ArrayBuffer) {
      const chunk = new Uint8Array(event.data);
      rxBytes += chunk.byteLength;
      reportStats();
      reader.push(chunk);
    } else if (typeof event.data === "string") {
      const chunk = utf8ToBytes(event.data);
      rxBytes += chunk.byteLength;
      reportStats();
      reader.push(chunk);
    } else if (event.data instanceof Blob) {
      const blob = event.data;
      incomingQueue = incomingQueue.then(async () => {
        if (closed) return;
        const ab = await blob.arrayBuffer();
        const chunk = new Uint8Array(ab);
        rxBytes += chunk.byteLength;
        reportStats();
        reader.push(chunk);
      });
    }
  };

  ws.onerror = () => {
    // Detailed reason will be handled in onclose if handshake was not completed
  };

  ws.onclose = (ev: CloseEvent) => {
    if (closed) {
      return;
    }
    if (!handshakeComplete) {
      if (ev.code === 1006) {
        // The relay refuses a knock nobody is listening for: log the failed
        // bind here, the termination line carries the reason.
        emitLog("error", "QSRN", `Bind attempt failed for ${resolved.uri}`);
        cleanup(`No peer is listening on ${resolved.uri}`, true);
        return;
      }
      const hint = `Relay closed connection during handshake (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ""}).`;
      emitLog("error", "QSRN", hint);
      cleanup(hint, true);
    } else {
      const msg = ev.reason || `Remote PTY session ended (code ${ev.code}).`;
      emitLog("info", "SESSION", msg);
      cleanup(msg, false);
    }
  };

  ws.onopen = async () => {
    if (closed) {
      return;
    }
    try {
      emitLog(
        "success",
        "QSRN",
        "HTTP 101 Switching Protocols — paired with listening peer on QSRN."
      );

      let fingerprint: string | null = null;
      let cipherSuite = "TLS (WSS only — E2E disabled)";

      if (e2e) {
        opts.onPhaseChange(
          "srp_exchange",
          "Negotiating SRP-6a PAKE (4096-bit safe prime, BLAKE2b-256)..."
        );
        emitLog(
          "info",
          "SRP-4096",
          "Generating ephemeral 4096-bit client keypair (g=5) and sending <I:A>..."
        );

        // Allow UI to paint status update before 4096-bit modular exponentiation
        await new Promise((r) => setTimeout(r, 10));

        const srp = new QSocketSrpClient(resolved.canonicalSecret);
        const clientCreds = srp.credentials();
        sendRawBytes(utf8ToBytes(clientCreds));

        const serverCreds = await withTimeout(
          reader.readSrpServerCreds(),
          HANDSHAKE_TIMEOUT_MS,
          "Timed out waiting for remote peer SRP credentials."
        );
        emitLog(
          "info",
          "SRP-4096",
          "Received peer salt & ephemeral public key B; computing shared secret S..."
        );

        const clientAuth = srp.generate(serverCreds);
        sendRawBytes(utf8ToBytes(clientAuth));

        const serverProofBytes = await withTimeout(
          reader.readExact(64),
          HANDSHAKE_TIMEOUT_MS,
          "Timed out waiting for remote peer SRP mutual proof."
        );
        const serverProof = bytesToUtf8(serverProofBytes);

        if (!srp.serverOk(serverProof)) {
          throw new Error(
            "SRP mutual authentication failed! Peer secret mismatch or tampered relay stream."
          );
        }

        const sessionKey = srp.rawKey();
        fingerprint = srp.sessionKeyFingerprint();
        cipherSuite = "SRP-AES-GCM-256-E2E (Prime: 4096)";

        emitLog(
          "success",
          "SRP-4096",
          `Mutual PAKE verified. Ephemeral 256-bit key fingerprint: ${fingerprint}`
        );

        opts.onPhaseChange(
          "e2e_init",
          "Initializing AES-256-GCM encrypted stream..."
        );
        dataStream = new QSocketEncryptedStream(
          sessionKey,
          reader,
          sendRawBytes
        );
        emitLog(
          "success",
          "E2E-GCM",
          "AES-256-GCM chunked stream active (MaxChunkSize: 65535, 96-bit random IV)."
        );
      } else {
        opts.onPhaseChange("e2e_init", "Using unencrypted stream (--no-e2e)...");
        emitLog(
          "warn",
          "PLAIN",
          "End-to-end encryption is disabled (--no-e2e). Relying on WSS transport only."
        );
        dataStream = new QSocketPlainStream(reader, sendRawBytes);
      }

      opts.onPhaseChange(
        "pty_session",
        "Sending QS v1 PTY session specs & terminal dimensions..."
      );
      const termSize = opts.getTerminalSize();
      emitLog(
        "info",
        "PTY-INIT",
        `Requesting CMD_SSH | FLAG_PTY (${termSize.cols}x${termSize.rows} cells, ${termSize.x}x${termSize.y}px)${
          opts.execCommand?.trim() ? ` exec="${opts.execCommand.trim()}"` : ""
        }`
      );

      await withTimeout(
        initPtySession(dataStream, termSize, opts.execCommand),
        HANDSHAKE_TIMEOUT_MS,
        "Timed out waiting for remote peer to accept PTY session specs."
      );

      handshakeComplete = true;
      emitLog(
        "success",
        "SESSION",
        "Remote peer returned STATUS_OK. Interactive PTY attached!"
      );
      opts.onPhaseChange("connected", "Interactive E2E PTY session active");
      opts.onSessionEstablished({
        resolvedSecret: resolved,
        wsUrl,
        e2eEnabled: e2e,
        cipherSuite,
        sessionKeyFingerprint: fingerprint,
        initialTermSize: termSize,
        connectedAt: Date.now(),
      });

      // Continuous decrypted socket read loop -> xterm.js
      while (!closed && dataStream) {
        const chunk = await dataStream.readSome();
        if (closed) break;
        if (chunk.length > 0) {
          opts.onOutput(chunk);
        }
      }
    } catch (err) {
      if (!closed) {
        const msg =
          err instanceof Error ? err.message : "QSocket handshake error.";
        emitLog("error", "PROTOCOL", msg);
        cleanup(msg, true);
      }
    }
  };

  return {
    sendInput: (data: string | Uint8Array) => {
      if (closed || !handshakeComplete || !dataStream) {
        return;
      }
      const raw = typeof data === "string" ? utf8ToBytes(data) : data;
      if (raw.length > 0) {
        try {
          dataStream.write(raw);
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Failed encrypting keystroke.";
          cleanup(msg, true);
        }
      }
    },
    disconnect: () => {
      emitLog("info", "SESSION", "Disconnected by user.");
      cleanup("Session closed by user.", false);
    },
  };
}
