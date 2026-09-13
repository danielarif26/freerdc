import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

const GENESIS_HASH = "0".repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_TAIL_RECORDS = 1_000;
const OUTCOMES = new Set(["planned", "started", "succeeded", "failed"]);
const RECORD_KEYS = new Set([
  "seq",
  "timestamp",
  "action",
  "outcome",
  "dryRun",
  "resource",
  "errorCode",
  "prevHash",
  "hash",
]);
const APPEND_KEYS = new Set(["timestamp", "action", "outcome", "dryRun", "resource", "errorCode"]);

export type AuditOutcome = "planned" | "started" | "succeeded" | "failed";

/** The only values accepted for appending an audit event. */
export interface AuditAppendInput {
  readonly timestamp?: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly dryRun: boolean;
  readonly resource?: string;
  readonly errorCode?: string;
}

export interface AuditRecord {
  readonly seq: number;
  readonly timestamp: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly dryRun: boolean;
  readonly resource?: string;
  readonly errorCode?: string;
  readonly prevHash: string;
  readonly hash: string;
}

export interface HashChainAuditLogOptions {
  readonly maxTailRecords?: number;
  /** Test hook for simulating an interrupted append. */
  readonly writeRecord?: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
}

/**
 * A local append-only JSONL audit log whose records are linked by SHA-256.
 * The constructor verifies the complete existing log before allowing writes.
 */
export class HashChainAuditLog {
  readonly #filePath: string;
  readonly #maxTailRecords: number;
  readonly #fd: number;
  readonly #writeRecord: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
  #closed = false;
  #lastSequence = 0;
  #lastHash = GENESIS_HASH;
  #tail: AuditRecord[] = [];

  constructor(filePath: string, options: HashChainAuditLogOptions = {}) {
    if (!isAbsolute(filePath)) {
      throw new Error("Audit log path must be absolute");
    }
    if (!Number.isSafeInteger(options.maxTailRecords ?? DEFAULT_MAX_TAIL_RECORDS) || (options.maxTailRecords ?? DEFAULT_MAX_TAIL_RECORDS) < 1) {
      throw new Error("maxTailRecords must be a positive safe integer");
    }

    const parentPath = dirname(filePath);
    let parent;
    try {
      parent = lstatSync(parentPath);
    } catch {
      throw new Error("Audit log parent directory must exist");
    }
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new Error("Audit log parent must be a non-symlink directory");
    }

    try {
      const target = lstatSync(filePath);
      if (target.isSymbolicLink() || !target.isFile()) {
        throw new Error("Audit log target must be a regular non-symlink file");
      }
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message === "Audit log target must be a regular non-symlink file") {
        throw error;
      }
      // A missing target is created below with O_APPEND; other lstat failures fail closed.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    this.#filePath = filePath;
    this.#maxTailRecords = options.maxTailRecords ?? DEFAULT_MAX_TAIL_RECORDS;
    this.#writeRecord = options.writeRecord ?? writeSync;
    this.#loadAndVerify();

    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    this.#fd = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | noFollow, 0o600);
    try {
      const target = fstatSync(this.#fd);
      if (!target.isFile()) {
        throw new Error("Audit log target must be a regular file");
      }
      try {
        fchmodSync(this.#fd, 0o600);
      } catch {
        // File creation permissions are authoritative; chmod is best effort for existing files.
      }
    } catch (error) {
      closeSync(this.#fd);
      throw error;
    }
  }

  append(input: AuditAppendInput): AuditRecord {
    this.#assertOpen();
    const safeInput = validateAppendInput(input);
    const record: AuditRecord = {
      seq: this.#lastSequence + 1,
      timestamp: safeInput.timestamp ?? new Date().toISOString(),
      action: safeInput.action,
      outcome: safeInput.outcome,
      dryRun: safeInput.dryRun,
      ...(safeInput.resource === undefined ? {} : { resource: safeInput.resource }),
      ...(safeInput.errorCode === undefined ? {} : { errorCode: safeInput.errorCode }),
      prevHash: this.#lastHash,
      hash: "",
    };
    const hash = calculateHash(record);
    const completedRecord = Object.freeze({ ...record, hash });
    const encoded = Buffer.from(`${canonicalJson(completedRecord)}\n`, "utf8");
    this.#writeAtomically(encoded);

    this.#lastSequence = completedRecord.seq;
    this.#lastHash = completedRecord.hash;
    this.#addToTail(completedRecord);
    return frozenCopy(completedRecord);
  }

  tail(limit = this.#maxTailRecords): readonly AuditRecord[] {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error("tail limit must be a non-negative safe integer");
    }
    const count = Math.min(limit, this.#maxTailRecords);
    if (count === 0) return Object.freeze([]);
    return Object.freeze(this.#tail.slice(-count).map(frozenCopy));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#fd);
  }

  #loadAndVerify(): void {
    let content: string;
    try {
      content = readFileSync(this.#filePath, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (content.length === 0) return;
    if (!content.endsWith("\n")) {
      throw new Error("Audit log is corrupt: final JSONL record is incomplete");
    }

    const lines = content.slice(0, -1).split("\n");
    for (const [index, line] of lines.entries()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Audit log is corrupt: invalid JSON at line ${index + 1}`);
      }
      const record = validateStoredRecord(parsed, index + 1, this.#lastSequence + 1, this.#lastHash);
      this.#lastSequence = record.seq;
      this.#lastHash = record.hash;
      this.#addToTail(record);
    }
  }

  #addToTail(record: AuditRecord): void {
    this.#tail.push(frozenCopy(record));
    if (this.#tail.length > this.#maxTailRecords) this.#tail.shift();
  }

  #writeAtomically(encoded: Buffer): void {
    const sizeBeforeAppend = fstatSync(this.#fd).size;
    let offset = 0;
    try {
      while (offset < encoded.byteLength) {
        const written = this.#writeRecord(this.#fd, encoded, offset, encoded.byteLength - offset);
        if (written <= 0) throw new Error("Audit log write made no progress");
        offset += written;
      }
    } catch (error) {
      ftruncateSync(this.#fd, sizeBeforeAppend);
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Audit log is closed");
  }
}

function validateAppendInput(value: AuditAppendInput): AuditAppendInput {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !APPEND_KEYS.has(key))) {
    throw new Error("Audit append input contains unsupported fields");
  }
  const candidate = value as Record<string, unknown>;
  validateSafeFields(candidate, "Audit append input");
  if (candidate.timestamp !== undefined) validateIsoTimestamp(candidate.timestamp, "Audit append input timestamp");
  return value;
}

function validateStoredRecord(value: unknown, line: number, expectedSequence: number, expectedPrevHash: string): AuditRecord {
  if (!isPlainObject(value) || Object.keys(value).some((key) => !RECORD_KEYS.has(key))) {
    throw new Error(`Audit log is corrupt: invalid schema at line ${line}`);
  }
  const record = value as Record<string, unknown>;
  validateSafeFields(record, `Audit log record at line ${line}`);
  if (record.seq !== expectedSequence || !Number.isSafeInteger(record.seq) || record.seq < 1) {
    throw new Error(`Audit log is corrupt: invalid sequence at line ${line}`);
  }
  validateIsoTimestamp(record.timestamp, `Audit log timestamp at line ${line}`);
  if (record.prevHash !== expectedPrevHash || typeof record.prevHash !== "string" || !HASH_PATTERN.test(record.prevHash)) {
    throw new Error(`Audit log is corrupt: invalid previous hash at line ${line}`);
  }
  if (typeof record.hash !== "string" || !HASH_PATTERN.test(record.hash)) {
    throw new Error(`Audit log is corrupt: invalid hash at line ${line}`);
  }
  const typed = record as unknown as AuditRecord;
  if (calculateHash(typed) !== typed.hash) {
    throw new Error(`Audit log is corrupt: hash mismatch at line ${line}`);
  }
  return Object.freeze({ ...typed });
}

function validateSafeFields(value: Record<string, unknown>, label: string): void {
  if (typeof value.action !== "string" || typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome) || typeof value.dryRun !== "boolean") {
    throw new Error(`${label} has invalid required fields`);
  }
  for (const key of ["resource", "errorCode"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${label} has invalid ${key}`);
    }
  }
}

function validateIsoTimestamp(value: unknown, label: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

function calculateHash(record: AuditRecord): string {
  const { hash: _hash, ...withoutHash } = record;
  return createHash("sha256").update(canonicalJson(withoutHash), "utf8").digest("hex");
}

function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function frozenCopy(record: AuditRecord): AuditRecord {
  return Object.freeze({ ...record });
}
