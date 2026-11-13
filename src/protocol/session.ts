import { bytesToUtf8, utf8ToBytes } from "./bytes";
import type { QSocketDataStream } from "./encryptedStream";

export const MAGIC_0 = 0x51; // 'Q'
export const MAGIC_1 = 0x53; // 'S'
export const SESSION_VERSION = 1;
export const SPECS_HEADER_LEN = 14;
export const RESPONSE_HEADER_LEN = 6;
export const FIELD_HEADER_LEN = 3;
export const MAX_FIELD_LEN = 0xffff;
export const MAX_FIELDS = 0xff;

export const CMD_NETCAT = 0;
export const CMD_SSH = 1;
export const CMD_SCP = 2;
export const CMD_FORWARD = 3;
export type SessionCommand =
  | typeof CMD_NETCAT
  | typeof CMD_SSH
  | typeof CMD_SCP
  | typeof CMD_FORWARD;

export const FLAG_PTY = 1 << 0; // 1
export const FLAG_RECURSIVE = 1 << 1; // 2
export const FLAG_UPLOAD = 1 << 2; // 4

export const FIELD_COMMAND = 1;
export const FIELD_ADDRESS = 2;
export const FIELD_PATH = 3;

export const STATUS_OK = 0;
export const STATUS_ERROR = 1;
export const STATUS_UNSUPPORTED = 2;
export const STATUS_NOT_FOUND = 3;
export const STATUS_NOT_REGULAR = 4;
export const STATUS_DENIED = 5;

export interface Winsize {
  rows: number;
  cols: number;
  x: number;
  y: number;
}

export interface SessionSpecs {
  id: SessionCommand;
  flags: number;
  termSize: Winsize;
  exec?: string;
  address?: string;
  path?: string;
}

export interface SessionResponse {
  status: number;
  message: string;
}

function clampUint16(v: number): number {
  if (!Number.isFinite(v) || v < 0) {
    return 0;
  }
  return Math.min(0xffff, Math.floor(v));
}

/**
 * Encodes SessionSpecs into its exact network-byte-order wire representation.
 * Matches SessionSpecs.Marshal() in github.com/qsocket/qsocket/session/protocol.go.
 */
export function marshalSessionSpecs(specs: SessionSpecs): Uint8Array {
  const rawFields: Array<{ type: number; bytes: Uint8Array }> = [];

  if (specs.exec && specs.exec.length > 0) {
    rawFields.push({ type: FIELD_COMMAND, bytes: utf8ToBytes(specs.exec) });
  }
  if (specs.address && specs.address.length > 0) {
    rawFields.push({ type: FIELD_ADDRESS, bytes: utf8ToBytes(specs.address) });
  }
  if (specs.path && specs.path.length > 0) {
    rawFields.push({ type: FIELD_PATH, bytes: utf8ToBytes(specs.path) });
  }

  if (rawFields.length > MAX_FIELDS) {
    throw new Error("Session specs exceed protocol field count limit.");
  }

  let totalSize = SPECS_HEADER_LEN;
  for (const f of rawFields) {
    if (f.bytes.length > MAX_FIELD_LEN) {
      throw new Error("Session specs field exceeds 65535-byte protocol limit.");
    }
    totalSize += FIELD_HEADER_LEN + f.bytes.length;
  }

  const buf = new Uint8Array(totalSize);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  buf[0] = MAGIC_0;
  buf[1] = MAGIC_1;
  buf[2] = SESSION_VERSION;
  buf[3] = specs.id & 0xff;
  buf[4] = specs.flags & 0xff;
  buf[5] = rawFields.length & 0xff;

  // BigEndian uint16 terminal geometry: ROWS (6..7), COLS (8..9), XPIXEL (10..11), YPIXEL (12..13)
  dv.setUint16(6, clampUint16(specs.termSize.rows), false);
  dv.setUint16(8, clampUint16(specs.termSize.cols), false);
  dv.setUint16(10, clampUint16(specs.termSize.x), false);
  dv.setUint16(12, clampUint16(specs.termSize.y), false);

  let offset = SPECS_HEADER_LEN;
  for (const f of rawFields) {
    buf[offset] = f.type & 0xff;
    dv.setUint16(offset + 1, f.bytes.length, false); // BigEndian uint16 field length
    buf.set(f.bytes, offset + FIELD_HEADER_LEN);
    offset += FIELD_HEADER_LEN + f.bytes.length;
  }

  return buf;
}

/**
 * Decodes SessionSpecs from a stream (used in self-tests).
 */
export async function readSessionSpecs(
  stream: QSocketDataStream
): Promise<SessionSpecs> {
  const header = await stream.readExact(SPECS_HEADER_LEN);
  if (header[0] !== MAGIC_0 || header[1] !== MAGIC_1) {
    throw new Error("Invalid session protocol magic.");
  }
  if (header[2] !== SESSION_VERSION) {
    throw new Error(`Unsupported session protocol version (${header[2]}).`);
  }

  const dv = new DataView(header.buffer, header.byteOffset, SPECS_HEADER_LEN);
  const id = header[3] as SessionCommand;
  const flags = header[4]!;
  const nFields = header[5]!;
  const rows = dv.getUint16(6, false);
  const cols = dv.getUint16(8, false);
  const x = dv.getUint16(10, false);
  const y = dv.getUint16(12, false);

  const specs: SessionSpecs = {
    id,
    flags,
    termSize: { rows, cols, x, y },
  };

  for (let i = 0; i < nFields; i++) {
    const fh = await stream.readExact(FIELD_HEADER_LEN);
    const fType = fh[0]!;
    const fLen = new DataView(fh.buffer, fh.byteOffset, 3).getUint16(1, false);
    const valBytes = await stream.readExact(fLen);
    const valStr = bytesToUtf8(valBytes);
    if (fType === FIELD_COMMAND) {
      specs.exec = valStr;
    } else if (fType === FIELD_ADDRESS) {
      specs.address = valStr;
    } else if (fType === FIELD_PATH) {
      specs.path = valStr;
    }
  }

  return specs;
}

/**
 * Encodes a SessionResponse into wire bytes (used in self-tests).
 */
export function marshalSessionResponse(
  status: number,
  message = ""
): Uint8Array {
  const msgBytes = utf8ToBytes(message);
  const buf = new Uint8Array(RESPONSE_HEADER_LEN + msgBytes.length);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf[0] = MAGIC_0;
  buf[1] = MAGIC_1;
  buf[2] = SESSION_VERSION;
  buf[3] = status & 0xff;
  dv.setUint16(4, msgBytes.length, false); // BigEndian uint16
  buf.set(msgBytes, RESPONSE_HEADER_LEN);
  return buf;
}

export function formatSessionStatusError(resp: SessionResponse): string {
  if (resp.message) {
    return resp.message;
  }
  switch (resp.status) {
    case STATUS_ERROR:
      return "Remote peer reported a session error.";
    case STATUS_UNSUPPORTED:
      return "Remote peer does not support the requested session command.";
    case STATUS_NOT_FOUND:
      return "Requested path not found on remote peer.";
    case STATUS_NOT_REGULAR:
      return "Requested path is not a regular file.";
    case STATUS_DENIED:
      return "Session request was denied by remote peer.";
    default:
      return `Remote peer rejected session (status code ${resp.status}).`;
  }
}

/**
 * Reads SessionResponse from the stream and validates magic & version.
 * Matches ReadResponse in github.com/qsocket/qsocket/session/protocol.go.
 */
export async function readSessionResponse(
  stream: QSocketDataStream
): Promise<SessionResponse> {
  const header = await stream.readExact(RESPONSE_HEADER_LEN);
  if (header[0] !== MAGIC_0 || header[1] !== MAGIC_1) {
    throw new Error("Invalid session protocol magic from remote peer.");
  }
  if (header[2] !== SESSION_VERSION) {
    throw new Error(
      `Unsupported session protocol version (${header[2]}) from remote peer.`
    );
  }
  const status = header[3]!;
  const msgLen = new DataView(
    header.buffer,
    header.byteOffset,
    RESPONSE_HEADER_LEN
  ).getUint16(4, false); // BigEndian uint16

  let message = "";
  if (msgLen > 0) {
    const msgBytes = await stream.readExact(msgLen);
    message = bytesToUtf8(msgBytes);
  }

  return { status, message };
}

/**
 * Sends SessionSpecs in a single encrypted write and awaits STATUS_OK response.
 * Matches InitSession in github.com/qsocket/qsocket/pkg/dial.go.
 */
export async function initPtySession(
  stream: QSocketDataStream,
  termSize: Winsize,
  execCommand = ""
): Promise<void> {
  const specs: SessionSpecs = {
    id: CMD_SSH,
    flags: FLAG_PTY,
    termSize,
    exec: execCommand.trim() || undefined,
  };

  const payload = marshalSessionSpecs(specs);
  stream.write(payload);

  const resp = await readSessionResponse(stream);
  if (resp.status !== STATUS_OK) {
    throw new Error(formatSessionStatusError(resp));
  }
}
