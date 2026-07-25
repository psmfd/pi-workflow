import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_JSONL_RECORD_BYTES = 1024 * 1024;
export const DEFAULT_MAX_JSONL_TOTAL_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_JSONL_EVENTS = 10_000;

export interface JsonlDecodeResult {
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strict LF-delimited JSON decoder used for pi's JSON and RPC protocols. */
export class StrictJsonlDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #events: Readonly<Record<string, unknown>>[] = [];
  readonly #maxRecordBytes: number;
  readonly #maxTotalBytes: number;
  readonly #maxEvents: number;
  #buffer = "";
  #totalBytes = 0;
  #error: string | undefined;

  constructor(options?: { maxRecordBytes?: number; maxTotalBytes?: number; maxEvents?: number }) {
    this.#maxRecordBytes = options?.maxRecordBytes ?? DEFAULT_MAX_JSONL_RECORD_BYTES;
    this.#maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_JSONL_TOTAL_BYTES;
    this.#maxEvents = options?.maxEvents ?? DEFAULT_MAX_JSONL_EVENTS;
  }

  get error(): string | undefined {
    return this.#error;
  }

  push(chunk: Buffer): void {
    if (this.#error !== undefined) return;
    this.#totalBytes += chunk.byteLength;
    if (this.#totalBytes > this.#maxTotalBytes) {
      this.#error = `JSONL stream exceeds ${this.#maxTotalBytes} bytes`;
      return;
    }
    this.#buffer += this.#decoder.write(chunk);
    this.#drain();
  }

  finish(): JsonlDecodeResult {
    if (this.#error === undefined) {
      this.#buffer += this.#decoder.end();
      this.#drain();
      if (this.#error === undefined && this.#buffer.length > 0) {
        this.#error = "JSONL stream ended with an unterminated record";
      }
    }

    return this.#error === undefined
      ? { events: [...this.#events] }
      : { events: [...this.#events], error: this.#error };
  }

  #drain(): void {
    while (this.#error === undefined) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) break;

      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#consume(line);
    }

    if (this.#error !== undefined) return;

    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxRecordBytes) {
      this.#error = `JSONL record exceeds ${this.#maxRecordBytes} bytes`;
      return;
    }

  }

  #consume(line: string): void {
    if (line.length === 0) return;
    if (Buffer.byteLength(line, "utf8") > this.#maxRecordBytes) {
      this.#error = `JSONL record exceeds ${this.#maxRecordBytes} bytes`;
      return;
    }
    if (this.#events.length >= this.#maxEvents) {
      this.#error = `JSONL event count exceeds ${this.#maxEvents}`;
      return;
    }

    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed) || typeof parsed["type"] !== "string") {
        this.#error = "JSONL record must be an object with a string type";
        return;
      }
      this.#events.push(parsed);
    } catch {
      this.#error = "Invalid JSONL record";
    }
  }
}
