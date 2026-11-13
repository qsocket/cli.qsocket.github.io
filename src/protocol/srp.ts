import { blake2b } from "@noble/hashes/blake2.js";
import { md5 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  concatBytes,
  constantTimeEqual,
  hexToBytes,
  utf8ToBytes,
} from "./bytes";

/**
 * SRP_BITS = 4096 from github.com/qsocket/qsocket-go/crypto.go
 * Prime field 4096:5:0x... from github.com/qsocket/go-srp/srp.go (RFC 3526 4096-bit MODP safe prime)
 */
export const SRP_BITS = 4096;
export const SRP_FIELD_BYTES = SRP_BITS / 8; // 512 bytes

const SRP_PRIME_4096_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74" +
  "020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F1437" +
  "4FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF05" +
  "98DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB" +
  "9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
  "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718" +
  "3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D04507A33" +
  "A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
  "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864" +
  "D87602733EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E2" +
  "08E24FA074E5AB3143DB5BFCE0FD108E4B82D120A92108011A723C12A787E6D7" +
  "88719A10BDBA5B2699C327186AF4E23C1A946834B6150BDA2583E9CA2AD44CE8" +
  "DBBBC2DB04DE8EF92E8EFC141FBECAA6287C59474E6BC05D99B2964FA090C3A2" +
  "233BA186515BE7ED1F612970CEE2D7AFB81BDD762170481CD0069127D5B05AA9" +
  "93B4EA988D8FDDC186FFB7DC90A6C08F4DF435C934063199FFFFFFFFFFFFFFFF";

export const SRP_N = BigInt("0x" + SRP_PRIME_4096_HEX);
export const SRP_G = 5n;

/**
 * Unkeyed BLAKE2b-256 hash matching Go's crypto.BLAKE2b_256 in go-srp.
 */
export function hashBytes(...parts: Uint8Array[]): Uint8Array {
  return blake2b(concatBytes(...parts), { dkLen: 32 });
}

export function hashInt(...parts: Uint8Array[]): bigint {
  return bytesToBigInt(hashBytes(...parts));
}

/**
 * Converts unsigned BigInt to big-endian byte array with NO leading zero bytes,
 * matching Go's math/big.Int.Bytes() (`0n` -> empty Uint8Array(0)).
 */
export function bigIntToBytes(x: bigint): Uint8Array {
  if (x < 0n) {
    throw new Error("bigIntToBytes expects non-negative BigInt.");
  }
  if (x === 0n) {
    return new Uint8Array(0);
  }
  let hex = x.toString(16);
  if (hex.length % 2 !== 0) {
    hex = "0" + hex;
  }
  return hexToBytes(hex);
}

/**
 * Converts big-endian byte array to unsigned BigInt, matching Go's big.NewInt(0).SetBytes(b).
 */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  if (bytes.length === 0) {
    return 0n;
  }
  return BigInt("0x" + bytesToHex(bytes));
}

/**
 * Parses a hex string into an unsigned BigInt (matching Go's big.NewInt(0).SetString(s, 16)).
 */
export function hexToBigInt(hex: string): bigint {
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("srp: invalid hex big integer");
  }
  return BigInt("0x" + hex);
}

/**
 * Left-pads BigInt x with zero bytes to n bytes, matching pad(x, n) in go-srp/srp.go.
 */
export function padBigInt(x: bigint, n: number): Uint8Array {
  const b = bigIntToBytes(x);
  if (b.length >= n) {
    return b;
  }
  const padded = new Uint8Array(n);
  padded.set(b, n - b.length);
  return padded;
}

/**
 * Modular exponentiation (base ^ exp) mod m, handling negative `base` identically
 * to Go's math/big.Int.Exp(x, y, m) by normalizing base into [0, m - 1] first.
 */
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod <= 0n) {
    throw new Error("Modulus must be positive.");
  }
  if (mod === 1n) {
    return 0n;
  }
  if (exp < 0n) {
    throw new Error("Negative exponent is not supported.");
  }

  let b = ((base % mod) + mod) % mod;
  let e = exp;
  let result = 1n;

  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = (result * b) % mod;
    }
    e >>= 1n;
    if (e > 0n) {
      b = (b * b) % mod;
    }
  }
  return result;
}

function randBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function randBigInt(bits: number): bigint {
  const byteLen = Math.ceil(bits / 8);
  return bytesToBigInt(randBytes(byteLen));
}

const N_BYTES = bigIntToBytes(SRP_N);
const G_BYTES = bigIntToBytes(SRP_G); // Uint8Array([5])
const G_PADDED = padBigInt(SRP_G, SRP_FIELD_BYTES); // 512 bytes
const SRP_K = hashInt(N_BYTES, G_PADDED);

/**
 * Client-side SRP-6a PAKE matching github.com/qsocket/qsocket-go InitClientSRP()
 * and github.com/qsocket/go-srp Client.
 */
export class QSocketSrpClient {
  private readonly i: Uint8Array;
  private readonly p: Uint8Array;
  private readonly a: bigint;
  private readonly xA: bigint;
  private xK: Uint8Array | null = null;
  private xM: Uint8Array | null = null;

  constructor(secret: string) {
    const secretBytes = utf8ToBytes(secret);
    const srpUser = md5(secretBytes); // 16 raw bytes: md5.Sum([]byte(qs.secret))
    const srpPass = sha256(secretBytes); // 32 raw bytes: sha256.Sum256([]byte(qs.secret))

    this.i = hashBytes(srpUser);
    this.p = hashBytes(srpPass);
    this.a = randBigInt(SRP_FIELD_BYTES * 8);
    this.xA = modPow(SRP_G, this.a, SRP_N);
  }

  /**
   * Returns client public credentials `<hex(i)>:<hex(A)>` to send to the server.
   */
  public credentials(): string {
    return `${bytesToHex(this.i)}:${bytesToHex(bigIntToBytes(this.xA))}`;
  }

  /**
   * Processes server credentials `<hex(salt)>:<hex(B)>`, derives ephemeral session key K,
   * and returns the hex-encoded mutual authenticator M (`64` hex chars).
   */
  public generate(serverCreds: string): string {
    const parts = serverCreds.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("SRP auth failed: invalid server public key format.");
    }
    if (parts[0].length % 2 !== 0) {
      throw new Error("SRP auth failed: malformed server salt.");
    }

    const salt = hexToBytes(parts[0]);
    const B = hexToBigInt(parts[1]);

    if (B % SRP_N === 0n) {
      throw new Error("SRP auth failed: invalid server public key (B mod N == 0).");
    }

    const u = hashInt(
      padBigInt(this.xA, SRP_FIELD_BYTES),
      padBigInt(B, SRP_FIELD_BYTES)
    );
    if (u === 0n) {
      throw new Error("SRP auth failed: invalid scrambling parameter (u == 0).");
    }

    // S := ((B - k * (g^x mod N)) ^ (a + u * x)) % N
    const x = hashInt(this.i, this.p, salt);
    const t0 = modPow(SRP_G, x, SRP_N) * SRP_K;
    const t1 = B - t0;
    const t2 = this.a + u * x;
    const S = modPow(t1, t2, SRP_N);

    this.xK = hashBytes(bigIntToBytes(S));
    this.xM = hashBytes(
      this.xK,
      bigIntToBytes(this.xA),
      bigIntToBytes(B),
      this.i,
      salt,
      N_BYTES,
      G_BYTES
    );

    return bytesToHex(this.xM);
  }

  /**
   * Verifies server proof `hex(BLAKE2b_256(K, M))` in constant time.
   */
  public serverOk(proof: string): boolean {
    if (!this.xK || !this.xM) {
      return false;
    }
    const expectedHex = bytesToHex(hashBytes(this.xK, this.xM));
    return constantTimeEqual(utf8ToBytes(expectedHex), utf8ToBytes(proof));
  }

  /**
   * Returns the 32-byte (256-bit) ephemeral session key K.
   */
  public rawKey(): Uint8Array {
    if (!this.xK) {
      throw new Error("SRP session key has not been generated yet.");
    }
    return this.xK;
  }

  /**
   * Computes a non-reversible visual fingerprint of the ephemeral session key
   * (first 8 bytes of SHA-256(K)) for UI verification without exposing key material.
   */
  public sessionKeyFingerprint(): string {
    const digest = sha256(this.rawKey());
    const hex = bytesToHex(digest.subarray(0, 6));
    return `${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}`;
  }
}

/**
 * Server-side SRP-6a responder matching InitServerSRP() in qsocket-go/crypto.go.
 * Included for protocol verification & self-test diagnostics.
 */
export class QSocketSrpServer {
  private readonly ih: Uint8Array;
  private readonly salt: Uint8Array;
  private readonly v: bigint;
  private xK: Uint8Array | null = null;
  private xM: Uint8Array | null = null;

  constructor(secret: string) {
    const secretBytes = utf8ToBytes(secret);
    const srpUser = md5(secretBytes);
    const srpPass = sha256(secretBytes);

    this.ih = hashBytes(srpUser);
    const ph = hashBytes(srpPass);
    this.salt = randBytes(SRP_FIELD_BYTES);
    const x = hashInt(this.ih, ph, this.salt);
    this.v = modPow(SRP_G, x, SRP_N);
  }

  public acceptClientCredentials(clientCreds: string): string {
    const parts = clientCreds.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error("SRP server: invalid client credentials.");
    }
    const idHex = parts[0];
    const expectedIdHex = bytesToHex(this.ih);
    if (!constantTimeEqual(utf8ToBytes(idHex), utf8ToBytes(expectedIdHex))) {
      throw new Error("SRP server: identity mismatch.");
    }

    const A = hexToBigInt(parts[1]);
    if (A % SRP_N === 0n) {
      throw new Error("SRP server: invalid client public key A.");
    }

    const b = randBigInt(SRP_FIELD_BYTES * 8);
    const kv = SRP_K * this.v;
    const gb = modPow(SRP_G, b, SRP_N);
    const B = (kv + gb) % SRP_N;

    const u = hashInt(
      padBigInt(A, SRP_FIELD_BYTES),
      padBigInt(B, SRP_FIELD_BYTES)
    );
    if (u === 0n) {
      throw new Error("SRP server: invalid u.");
    }

    const vu = modPow(this.v, u, SRP_N);
    const Avu = (A * vu) % SRP_N;
    const S = modPow(Avu, b, SRP_N);

    this.xK = hashBytes(bigIntToBytes(S));
    this.xM = hashBytes(
      this.xK,
      bigIntToBytes(A),
      bigIntToBytes(B),
      this.ih,
      this.salt,
      N_BYTES,
      G_BYTES
    );

    return `${bytesToHex(this.salt)}:${bytesToHex(bigIntToBytes(B))}`;
  }

  public verifyClientAuth(mAuth: string): { ok: boolean; proof: string } {
    if (!this.xK || !this.xM) {
      return { ok: false, proof: "" };
    }
    const expectedM = bytesToHex(this.xM);
    if (!constantTimeEqual(utf8ToBytes(expectedM), utf8ToBytes(mAuth))) {
      return { ok: false, proof: "" };
    }
    const proof = bytesToHex(hashBytes(this.xK, this.xM));
    return { ok: true, proof };
  }

  public rawKey(): Uint8Array {
    if (!this.xK) {
      throw new Error("SRP server key not initialized.");
    }
    return this.xK;
  }
}
