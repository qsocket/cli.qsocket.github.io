import { gcm } from "@noble/ciphers/aes.js";
import { ByteStreamReader } from "./bytes";

export const MAX_CHUNK_SIZE = 65535;
export const AES_GCM_NONCE_SIZE = 12;
export const AES_GCM_TAG_SIZE = 16;
export const MAX_ENCRYPTED_PAYLOAD_SIZE =
  MAX_CHUNK_SIZE + AES_GCM_NONCE_SIZE + AES_GCM_TAG_SIZE;

export interface QSocketDataStream {
  write(data: Uint8Array): void;
  readSome(): Promise<Uint8Array>;
  readExact(n: number): Promise<Uint8Array>;
}

/**
 * Encodes a single plaintext chunk (<= 65535 bytes) into an encrypted-stream wire frame:
 *   [4-byte Little-Endian payloadLen][12-byte random nonce][AES-256-GCM ciphertext + 16-byte tag]
 * Matches Encoder.Encode + writeVarBytes in github.com/qsocket/encrypted-stream.
 */
export function encodeEncryptedChunk(
  key: Uint8Array,
  plainChunk: Uint8Array,
  initiator = false
): Uint8Array {
  if (plainChunk.length > MAX_CHUNK_SIZE) {
    throw new Error(`Plaintext chunk exceeds MaxChunkSize (${MAX_CHUNK_SIZE}).`);
  }

  const nonce = new Uint8Array(AES_GCM_NONCE_SIZE);
  crypto.getRandomValues(nonce);
  // Matches encoding.go: if initiator { nonce[0] &= 127 } else { nonce[0] |= 128 }
  if (initiator) {
    nonce[0] = nonce[0]! & 0x7f;
  } else {
    nonce[0] = nonce[0]! | 0x80;
  }

  const sealed = gcm(key, nonce).encrypt(plainChunk);
  const payloadLen = AES_GCM_NONCE_SIZE + sealed.length;

  const frame = new Uint8Array(4 + payloadLen);
  const dv = new DataView(frame.buffer, frame.byteOffset, 4);
  dv.setUint32(0, payloadLen, true); // LittleEndian uint32 per writeVarBytes
  frame.set(nonce, 4);
  frame.set(sealed, 4 + AES_GCM_NONCE_SIZE);

  return frame;
}

/**
 * Decodes a single encrypted-stream payload (without the 4-byte length prefix):
 *   [12-byte nonce][AES-256-GCM ciphertext + 16-byte tag] -> plaintext
 * Matches Decoder.Decode with DisableNonceVerification: true in qsocket-go/crypto.go.
 */
export function decodeEncryptedPayload(
  key: Uint8Array,
  payload: Uint8Array
): Uint8Array {
  if (payload.length < AES_GCM_NONCE_SIZE + AES_GCM_TAG_SIZE) {
    throw new Error(`Invalid encrypted payload size (${payload.length} bytes).`);
  }
  const nonce = payload.subarray(0, AES_GCM_NONCE_SIZE);
  const ciphertextWithTag = payload.subarray(AES_GCM_NONCE_SIZE);
  return gcm(key, nonce).decrypt(ciphertextWithTag);
}

/**
 * End-to-End AES-256-GCM EncryptedStream matching InitE2ECipher in qsocket-go/crypto.go.
 */
export class QSocketEncryptedStream implements QSocketDataStream {
  private readonly key: Uint8Array;
  private readonly reader: ByteStreamReader;
  private readonly sendFrame: (frame: Uint8Array) => void;
  private decryptBuffer: Uint8Array = new Uint8Array(0);
  private decryptOffset = 0;

  constructor(
    key: Uint8Array,
    reader: ByteStreamReader,
    sendFrame: (frame: Uint8Array) => void
  ) {
    if (key.length !== 16 && key.length !== 32) {
      throw new Error(`AES-GCM key must be 16 or 32 bytes (got ${key.length}).`);
    }
    this.key = key;
    this.reader = reader;
    this.sendFrame = sendFrame;
  }

  public write(data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }
    let offset = 0;
    while (offset < data.length) {
      const end = Math.min(offset + MAX_CHUNK_SIZE, data.length);
      const chunk = data.subarray(offset, end);
      const frame = encodeEncryptedChunk(this.key, chunk, false);
      this.sendFrame(frame);
      offset = end;
    }
  }

  private async ensureDecryptedBytes(): Promise<void> {
    while (this.decryptOffset >= this.decryptBuffer.length) {
      const lenBuf = await this.reader.readExact(4);
      const dv = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4);
      const payloadLen = dv.getUint32(0, true); // LittleEndian uint32 per readVarBytes

      if (
        payloadLen < AES_GCM_NONCE_SIZE + AES_GCM_TAG_SIZE ||
        payloadLen > MAX_ENCRYPTED_PAYLOAD_SIZE
      ) {
        throw new Error(
          `Received invalid encrypted chunk size (${payloadLen} bytes).`
        );
      }

      const payload = await this.reader.readExact(payloadLen);
      this.decryptBuffer = decodeEncryptedPayload(this.key, payload);
      this.decryptOffset = 0;
    }
  }

  public async readSome(): Promise<Uint8Array> {
    await this.ensureDecryptedBytes();
    const out = this.decryptBuffer.subarray(this.decryptOffset);
    this.decryptOffset = this.decryptBuffer.length;
    return out;
  }

  public async readExact(n: number): Promise<Uint8Array> {
    if (n === 0) {
      return new Uint8Array(0);
    }
    const out = new Uint8Array(n);
    let filled = 0;

    while (filled < n) {
      await this.ensureDecryptedBytes();
      const available = this.decryptBuffer.length - this.decryptOffset;
      const take = Math.min(available, n - filled);
      out.set(
        this.decryptBuffer.subarray(this.decryptOffset, this.decryptOffset + take),
        filled
      );
      this.decryptOffset += take;
      filled += take;
    }

    return out;
  }
}

/**
 * Unencrypted pass-through stream when E2E is explicitly disabled (--no-e2e).
 */
export class QSocketPlainStream implements QSocketDataStream {
  private readonly reader: ByteStreamReader;
  private readonly sendFrame: (frame: Uint8Array) => void;

  constructor(reader: ByteStreamReader, sendFrame: (frame: Uint8Array) => void) {
    this.reader = reader;
    this.sendFrame = sendFrame;
  }

  public write(data: Uint8Array): void {
    if (data.length > 0) {
      this.sendFrame(data);
    }
  }

  public readSome(): Promise<Uint8Array> {
    return this.reader.readSome(16384);
  }

  public readExact(n: number): Promise<Uint8Array> {
    return this.reader.readExact(n);
  }
}
