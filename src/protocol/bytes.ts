import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export { bytesToHex, hexToBytes };

export function utf8ToBytes(str: string): Uint8Array {
  return textEncoder.encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const arr of arrays) {
    totalLen += arr.length;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Standard RFC 4648 Base64 encoding (matches Go's base64.StdEncoding.EncodeToString).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Constant-time comparison matching Go's subtle.ConstantTimeCompare.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Buffered async byte stream reader modeled after qsocket-go's bufferedConn / bufio.Reader.
 * Ensures bytes arriving together across protocol stages (SRP -> EncryptedStream -> PTY)
 * are never dropped or split improperly.
 */
export class ByteStreamReader {
  private chunks: Uint8Array[] = [];
  private headOffset = 0;
  private totalBytes = 0;
  private closedError: Error | null = null;
  private waiters: Array<() => void> = [];

  public push(chunk: Uint8Array): void {
    if (chunk.length === 0 || this.closedError) {
      return;
    }
    this.chunks.push(chunk);
    this.totalBytes += chunk.length;
    this.notify();
  }

  public close(err?: Error): void {
    if (this.closedError) {
      return;
    }
    this.closedError = err ?? new Error("QSocket connection closed.");
    this.notify();
  }

  public get bufferedLength(): number {
    return this.totalBytes;
  }

  public get isClosed(): boolean {
    return this.closedError !== null;
  }

  private notify(): void {
    const current = this.waiters.splice(0, this.waiters.length);
    for (const wake of current) {
      wake();
    }
  }

  private waitForData(): Promise<void> {
    if (this.closedError) {
      return Promise.reject(this.closedError);
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push(() => {
        if (this.closedError && this.totalBytes === 0) {
          reject(this.closedError);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Reads up to maxBytes as soon as at least 1 byte is available (like Go io.Reader.Read).
   */
  public async readSome(maxBytes = 4096): Promise<Uint8Array> {
    while (this.totalBytes === 0) {
      if (this.closedError) {
        throw this.closedError;
      }
      await this.waitForData();
    }
    const toRead = Math.min(maxBytes, this.totalBytes);
    return this.consume(toRead);
  }

  /**
   * Reads exact n bytes (like Go io.ReadFull).
   */
  public async readExact(n: number): Promise<Uint8Array> {
    if (n === 0) {
      return new Uint8Array(0);
    }
    while (this.totalBytes < n) {
      if (this.closedError) {
        throw this.closedError;
      }
      await this.waitForData();
    }
    return this.consume(n);
  }

  /**
   * Reads the SRP-4096 server credentials string `<hex(salt)>:<hex(B)>`.
   * In go-srp (4096-bit prime), salt is 512 bytes (1024 hex chars), followed by ':',
   * followed by hex(B.Bytes()) (~1022-1024 even-length hex chars).
   * Handles both single WebSocket record delivery and TCP-segmented multi-frame delivery.
   */
  public async readSrpServerCreds(): Promise<string> {
    while (true) {
      while (this.totalBytes === 0) {
        if (this.closedError) {
          throw this.closedError;
        }
        await this.waitForData();
      }

      const preview = this.peekAll();
      const str = bytesToUtf8(preview);
      const colonIdx = str.indexOf(":");

      if (colonIdx > 0) {
        const bHexLen = str.length - colonIdx - 1;
        // For SRP-4096, salt hex is 1024 chars and B hex is >= 1016 even chars (typically 1024).
        if (bHexLen >= 1016 && bHexLen % 2 === 0) {
          return bytesToUtf8(this.consume(preview.length));
        }
        // Fallback in the astronomically rare case B has leading zero bytes (< 508 bytes):
        // wait briefly to see if another TCP segment is immediately trailing.
        if (bHexLen >= 2 && bHexLen % 2 === 0) {
          const prevTotal = this.totalBytes;
          await new Promise((r) => setTimeout(r, 35));
          if (this.totalBytes === prevTotal) {
            return bytesToUtf8(this.consume(preview.length));
          }
          continue;
        }
      }

      if (this.totalBytes > 8192) {
        throw new Error("Invalid SRP server credentials frame (exceeded max size).");
      }
      if (this.closedError) {
        throw this.closedError;
      }
      await this.waitForData();
    }
  }

  private peekAll(): Uint8Array {
    const out = new Uint8Array(this.totalBytes);
    let dstOffset = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i]!;
      const src = i === 0 ? chunk.subarray(this.headOffset) : chunk;
      out.set(src, dstOffset);
      dstOffset += src.length;
    }
    return out;
  }

  private consume(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let written = 0;

    while (written < n && this.chunks.length > 0) {
      const head = this.chunks[0]!;
      const available = head.length - this.headOffset;
      const take = Math.min(available, n - written);
      out.set(head.subarray(this.headOffset, this.headOffset + take), written);
      written += take;
      this.headOffset += take;
      this.totalBytes -= take;

      if (this.headOffset >= head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }

    return out;
  }
}
