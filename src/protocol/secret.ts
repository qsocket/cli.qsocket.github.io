import { md5 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToBase64, bytesToHex, hexToBytes, utf8ToBytes } from "./bytes";

export const URI_SCHEME = "qs://";
const UUID_LEN = 36;
const UUID_DASHES = [8, 13, 18, 23] as const;

export interface ResolvedQSocketSecret {
  /** Raw trimmed input entered by the user */
  rawInput: string;
  /** Canonical secret passed to qsocket.NewSocket(Client, secret) */
  canonicalSecret: string;
  /** Canonical qs://<uuid> URI representation */
  uri: string;
  /** 16-byte MD5(canonicalSecret) knock UID */
  uidBytes: Uint8Array;
  /** Standard Base64 encoded UID sent via ?key= query parameter */
  uidBase64: string;
  /** Hex representation of the 16-byte UID */
  uidHex: string;
  /** True when a non-UUID secret was hashed into a v8 UUID per qsocket/config/uri.go */
  wasDerivedUUID: boolean;
}

/**
 * Formats 16 raw bytes as a canonical lowercase UUID string (8-4-4-4-12).
 * Matches FormatUUID in github.com/qsocket/qsocket/config/uri.go.
 */
export function formatUUID(raw: Uint8Array): string {
  if (raw.length !== 16) {
    throw new Error("UUID raw buffer must be 16 bytes.");
  }
  const hex = bytesToHex(raw);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Validates a canonical dash-separated UUID and returns its lowercase form, or null.
 * Matches ParseUUID in github.com/qsocket/qsocket/config/uri.go.
 */
export function parseUUID(v: string): string | null {
  if (v.length !== UUID_LEN) {
    return null;
  }
  for (const idx of UUID_DASHES) {
    if (v[idx] !== "-") {
      return null;
    }
  }
  const hexDigits = v.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hexDigits)) {
    return null;
  }
  const raw = hexToBytes(hexDigits);
  if (raw.length !== 16) {
    return null;
  }
  return formatUUID(raw);
}

/**
 * Hashes an arbitrary secret into a deterministic RFC 9562 Version 8 UUID.
 * Matches DeriveUUID in github.com/qsocket/qsocket/config/uri.go:
 *   sum := sha256.Sum256([]byte(secret))
 *   raw := sum[:16]
 *   raw[6] = (raw[6] & 0x0F) | 0x80 // Version 8 (custom)
 *   raw[8] = (raw[8] & 0x3F) | 0x80 // Variant 1 (RFC 4122/9562)
 */
export function deriveUUIDv8(secret: string): string {
  const sum = sha256(utf8ToBytes(secret));
  const raw = sum.slice(0, 16);
  raw[6] = (raw[6]! & 0x0f) | 0x80;
  raw[8] = (raw[8]! & 0x3f) | 0x80;
  return formatUUID(raw);
}

/**
 * Generates a cryptographically random Version 4 UUID (matches `qsock -g`).
 */
export function generateRandomUUIDv4(): string {
  const raw = new Uint8Array(16);
  crypto.getRandomValues(raw);
  raw[6] = (raw[6]! & 0x0f) | 0x40;
  raw[8] = (raw[8]! & 0x3f) | 0x80;
  return formatUUID(raw);
}

/**
 * Resolves user input (`qs://<secret>` or `<secret>`) into the canonical secret and QSRN knock UID.
 *
 * By default (`normalizeToUuid = true`), matches `qsock` (v0.1.0+) behavior where non-UUID
 * secrets are normalized via `DeriveUUID` before passing to `qsocket.NewSocket`.
 * When `normalizeToUuid = false`, passes the bare secret string directly to `qsocket.NewSocket`
 * (for direct compatibility with custom `qsocket-go` programs not using `config/uri.go`).
 * Note: For standard UUID secrets (from `qsock -g`), both modes produce the exact same result!
 */
export function resolveQSocketSecret(
  input: string,
  normalizeToUuid = true
): ResolvedQSocketSecret {
  const rawInput = input.trim();
  if (!rawInput) {
    throw new Error("QSocket secret cannot be empty.");
  }

  // Strip leading qs:// scheme if provided; reject mistyped schemes like http:// or qs:/
  let stripped = rawInput;
  if (rawInput.startsWith(URI_SCHEME)) {
    stripped = rawInput.slice(URI_SCHEME.length);
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawInput)) {
    throw new Error(`Invalid URI scheme in secret "${rawInput}". Expected qs://<secret> or <secret>.`);
  }

  if (!stripped) {
    throw new Error("QSocket URI carries no secret.");
  }

  let canonicalSecret: string;
  let wasDerivedUUID = false;

  if (normalizeToUuid) {
    const parsedUuid = parseUUID(stripped);
    if (parsedUuid !== null) {
      canonicalSecret = parsedUuid;
    } else {
      canonicalSecret = deriveUUIDv8(stripped);
      wasDerivedUUID = true;
    }
  } else {
    canonicalSecret = stripped;
  }

  const secretBytes = utf8ToBytes(canonicalSecret);
  const uidBytes = md5(secretBytes); // 16-byte UID as in qsocket.NewSocket
  const uidBase64 = bytesToBase64(uidBytes);
  const uidHex = bytesToHex(uidBytes);

  return {
    rawInput,
    canonicalSecret,
    uri: `${URI_SCHEME}${canonicalSecret}`,
    uidBytes,
    uidBase64,
    uidHex,
    wasDerivedUUID,
  };
}

/**
 * Computes NextUID on a UID chain: md5(uid) (matches qsocket.NextUID in knock.go).
 */
export function nextUID(uid: Uint8Array): Uint8Array {
  return md5(uid);
}

/**
 * Extracts initial secret from window.location.hash if present.
 */
export function extractSecretFromUrlHash(hash: string): string {
  if (!hash || hash === "#") {
    return "";
  }
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}
