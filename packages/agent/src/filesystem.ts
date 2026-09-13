import {
  closeSync,
  constants as fsConstants,
  ftruncateSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { checkPath, isDenied, isUnsafeFilesystemRoot } from '@freerdc/guard';
import {
  E_KILLSWITCH,
  E_PATH_DENIED,
  E_PATH_ESCAPE,
  E_STALE_HASH,
  E_TOO_LARGE,
  FreeRdcError,
} from '@freerdc/protocol';

import { isKillSwitchActive, type StateProvider } from './kill-switch.js';
import { DEFAULT_AGENT_LIMITS, type AgentLimits } from './types.js';

/** The intentionally small metadata surface exposed by SafeFilesystem. */
export interface SafeFilesystemEntry {
  readonly path: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly mtimeMs: number;
}

export interface SafeFilesystemListResult {
  readonly entries: readonly SafeFilesystemEntry[];
  readonly truncated: boolean;
}

export interface SafeFilesystemSearchMatch {
  readonly path: string;
  readonly matchCount: number;
}

export interface SafeFilesystemSearchResult {
  readonly matches: readonly SafeFilesystemSearchMatch[];
  readonly truncated: boolean;
}

export interface SafeFilesystemSearchOptions {
  readonly caseSensitive?: boolean;
  readonly maxDepth?: number;
}

export type SafeFilesystemDryRun = 'off' | 'plan';

export interface SafeFilesystemMutationOptions {
  readonly dryRun?: SafeFilesystemDryRun;
}

export interface SafeFilesystemWriteOptions extends SafeFilesystemMutationOptions {
  readonly expectedSha256?: string;
}

export interface SafeFilesystemDeleteFileOptions extends SafeFilesystemMutationOptions {
  readonly expectedSha256: string;
}

export interface SafeFilesystemMoveFileOptions extends SafeFilesystemMutationOptions {
  readonly expectedSha256: string;
}

/** Metadata for a completed mutation or a side-effect-free mutation plan. */
export interface SafeFilesystemMutationResult {
  readonly operation: 'mkdir' | 'write' | 'deleteFile' | 'moveFile';
  readonly path: string;
  readonly source?: string;
  readonly destination?: string;
  readonly planned: boolean;
}

export interface SafeFilesystemLimits {
  readonly maxReadBytes?: number;
  readonly maxWriteBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxSearchResults?: number;
  readonly maxSearchBytes?: number;
}

export interface SafeFilesystemOptions {
  readonly roots: readonly string[];
  readonly limits?: SafeFilesystemLimits;
  readonly stateProvider?: StateProvider;
}

interface ResolvedPath {
  readonly path: string;
  readonly realPath?: string;
}

/**
 * A filesystem view over an explicit set of canonical directory roots.
 */
export class SafeFilesystem {
  readonly #roots: readonly string[];
  readonly #limits: Readonly<Pick<AgentLimits, 'maxReadBytes' | 'maxWriteBytes' | 'maxOutputBytes' | 'maxSearchResults' | 'maxSearchBytes'>>;
  readonly #stateProvider?: StateProvider;

  constructor({ roots, limits, stateProvider }: SafeFilesystemOptions) {
    if (!Array.isArray(roots) || roots.length === 0) {
      throw escapeError();
    }

    const canonicalRoots: string[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      if (!isAbsolutePath(root)) {
        throw escapeError();
      }
      if (isUnsafeFilesystemRoot(root)) {
        throw deniedError();
      }
      if (isDenied(root)) {
        throw deniedError();
      }

      let canonicalRoot: string;
      try {
        if (!statSync(root).isDirectory()) {
          throw escapeError();
        }
        canonicalRoot = realpathSync(root);
      } catch (error) {
        if (error instanceof FreeRdcError) {
          throw error;
        }
        throw escapeError();
      }

      if (isDenied(canonicalRoot)) {
        throw deniedError();
      }
      if (isUnsafeFilesystemRoot(canonicalRoot)) {
        throw deniedError();
      }

      const key = process.platform === 'darwin' || process.platform === 'win32'
        ? canonicalRoot.toLowerCase()
        : canonicalRoot;
      if (!seen.has(key)) {
        seen.add(key);
        canonicalRoots.push(canonicalRoot);
      }
    }

    this.#roots = Object.freeze(canonicalRoots);
    this.#limits = Object.freeze({
      maxReadBytes: boundedLimit(limits?.maxReadBytes, DEFAULT_AGENT_LIMITS.maxReadBytes),
      maxWriteBytes: boundedLimit(limits?.maxWriteBytes, DEFAULT_AGENT_LIMITS.maxWriteBytes),
      maxOutputBytes: boundedLimit(limits?.maxOutputBytes, DEFAULT_AGENT_LIMITS.maxOutputBytes),
      maxSearchResults: boundedLimit(limits?.maxSearchResults, DEFAULT_AGENT_LIMITS.maxSearchResults),
      maxSearchBytes: boundedLimit(limits?.maxSearchBytes, DEFAULT_AGENT_LIMITS.maxSearchBytes),
    });
    this.#stateProvider = stateProvider;
  }

  stat(candidate: string): SafeFilesystemEntry {
    this.#assertActive();
    const resolved = this.#resolve(candidate);
    const entry = entryFromPath(resolved.path);
    this.#verifyUnchanged(resolved);
    return entry;
  }

  read(candidate: string): Buffer {
    this.#assertActive();
    const resolved = this.#resolve(candidate);
    const info = statSync(resolved.path);
    if (!info.isFile()) {
      throw escapeError();
    }

    const limit = Math.min(this.#limits.maxReadBytes, this.#limits.maxOutputBytes);
    if (info.size > limit) {
      throw tooLargeError();
    }

    const data = readFileSync(resolved.path);
    if (data.byteLength > limit) {
      throw tooLargeError();
    }
    this.#verifyUnchanged(resolved);
    return data;
  }

  list(candidate: string): SafeFilesystemListResult {
    this.#assertActive();
    const resolved = this.#resolve(candidate);
    if (!statSync(resolved.path).isDirectory()) {
      throw escapeError();
    }

    const entries: SafeFilesystemEntry[] = [];
    let truncated = false;
    const children = readdirSync(resolved.path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const childPath = path.join(resolved.path, child.name);
      let safeChild: ResolvedPath;
      let entry: SafeFilesystemEntry;
      try {
        safeChild = this.#resolve(childPath);
        entry = entryFromPath(safeChild.path);
        this.#verifyUnchanged(safeChild);
      } catch (error) {
        if (isUnsafeChildError(error)) {
          continue;
        }
        // A concurrent deletion or an unreadable child is not a listing failure.
        if (isFilesystemError(error)) {
          continue;
        }
        throw error;
      }

      if (entries.length >= this.#limits.maxSearchResults) {
        truncated = true;
        break;
      }
      if (wouldExceedOutputLimit(entries, entry, this.#limits.maxOutputBytes)) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }

    this.#verifyUnchanged(resolved);
    return { entries, truncated };
  }

  search(
    startRoot: string,
    needle: string,
    options?: SafeFilesystemSearchOptions,
  ): SafeFilesystemSearchResult {
    this.#assertActive();
    if (typeof needle !== 'string' || needle.length === 0 || needle.includes('\0')) {
      throw escapeError();
    }

    const caseSensitive = options?.caseSensitive ?? false;
    const maxDepth = options?.maxDepth ?? 16;
    if (typeof caseSensitive !== 'boolean' || !Number.isInteger(maxDepth) || maxDepth < 0) {
      throw escapeError();
    }

    const start = this.#resolve(startRoot);
    if (!statSync(start.path).isDirectory()) {
      throw escapeError();
    }

    const matches: SafeFilesystemSearchMatch[] = [];
    const pending: Array<{ path: string; depth: number }> = [{ path: start.path, depth: 0 }];
    let bytesRead = 0;
    let truncated = false;

    while (pending.length > 0 && !truncated) {
      const current = pending.pop();
      if (current === undefined) {
        break;
      }

      let children: string[];
      try {
        children = readdirSync(current.path).sort((left, right) => left.localeCompare(right));
      } catch (error) {
        if (isFilesystemError(error)) {
          continue;
        }
        throw error;
      }

      const directories: Array<{ path: string; depth: number }> = [];
      for (const name of children) {
        const childPath = path.join(current.path, name);
        let linkStats: ReturnType<typeof lstatSync>;
        let safeChild: ResolvedPath;
        try {
          linkStats = lstatSync(childPath);
          safeChild = this.#resolve(childPath);
        } catch (error) {
          if (isUnsafeChildError(error) || isFilesystemError(error)) {
            continue;
          }
          throw error;
        }

        if (linkStats.isDirectory()) {
          if (current.depth < maxDepth) {
            directories.push({ path: safeChild.path, depth: current.depth + 1 });
          }
          continue;
        }

        if (!linkStats.isFile() && !linkStats.isSymbolicLink()) {
          continue;
        }

        let fileStats: ReturnType<typeof statSync>;
        try {
          fileStats = statSync(safeChild.path);
          if (!fileStats.isFile()) {
            continue;
          }
          if (fileStats.size > this.#limits.maxSearchBytes - bytesRead) {
            truncated = true;
            break;
          }
        } catch (error) {
          if (isUnsafeChildError(error) || isFilesystemError(error)) {
            continue;
          }
          throw error;
        }

        let data: Buffer;
        try {
          data = readFileSync(safeChild.path);
          if (data.byteLength > this.#limits.maxSearchBytes - bytesRead) {
            truncated = true;
            break;
          }
          bytesRead += data.byteLength;
          this.#verifyUnchanged(safeChild);
        } catch (error) {
          if (isUnsafeChildError(error) || isFilesystemError(error)) {
            continue;
          }
          throw error;
        }

        const matchCount = countLiteralMatches(data.toString(), needle, caseSensitive);
        if (matchCount === 0) {
          continue;
        }

        const match: SafeFilesystemSearchMatch = { path: safeChild.path, matchCount };
        if (matches.length >= this.#limits.maxSearchResults ||
          wouldExceedSearchOutputLimit(matches, match, this.#limits.maxOutputBytes)) {
          truncated = true;
          break;
        }
        matches.push(match);
      }

      for (let index = directories.length - 1; index >= 0; index -= 1) {
        const directory = directories[index];
        if (directory !== undefined) {
          pending.push(directory);
        }
      }
    }

    this.#verifyUnchanged(start);
    return { matches, truncated };
  }

  mkdir(candidate: string, options?: SafeFilesystemMutationOptions): SafeFilesystemMutationResult {
    this.#assertActive();
    const dryRun = mutationDryRun(options?.dryRun);
    const target = this.#resolveNewTarget(candidate);
    this.#assertDoesNotExist(target.path);
    const result: SafeFilesystemMutationResult = { operation: 'mkdir', path: target.path, planned: dryRun === 'plan' };
    if (dryRun === 'plan') {
      return result;
    }

    this.#recheckNewTarget(target);
    mkdirSync(target.path);
    return result;
  }

  write(candidate: string, data: Buffer | string, options?: SafeFilesystemWriteOptions): SafeFilesystemMutationResult {
    this.#assertActive();
    const dryRun = mutationDryRun(options?.dryRun);
    if (!(Buffer.isBuffer(data) || typeof data === 'string')) {
      throw escapeError();
    }
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (content.byteLength > this.#limits.maxWriteBytes) {
      throw tooLargeError();
    }

    const target = this.#resolveNewTarget(candidate);
    const existing = this.#existingRegularFile(target.path);
    if (existing) {
      this.#assertExpectedHash(target.path, options?.expectedSha256);
    } else if (options?.expectedSha256 !== undefined && options.expectedSha256.length > 0) {
      throw staleHashError();
    }
    const result: SafeFilesystemMutationResult = { operation: 'write', path: target.path, planned: dryRun === 'plan' };
    if (dryRun === 'plan') {
      return result;
    }

    this.#recheckNewTarget(target);
    this.#writeFile(target.path, content, existing, options?.expectedSha256);
    return result;
  }

  deleteFile(candidate: string, options: SafeFilesystemDeleteFileOptions): SafeFilesystemMutationResult {
    this.#assertActive();
    const dryRun = mutationDryRun(options?.dryRun);
    const target = this.#resolve(candidate);
    this.#assertExpectedHash(target.path, options?.expectedSha256);
    const result: SafeFilesystemMutationResult = { operation: 'deleteFile', path: target.path, planned: dryRun === 'plan' };
    if (dryRun === 'plan') {
      return result;
    }

    this.#recheckExistingRegularFile(target);
    unlinkSync(target.path);
    return result;
  }

  moveFile(source: string, destination: string, options: SafeFilesystemMoveFileOptions): SafeFilesystemMutationResult {
    this.#assertActive();
    const dryRun = mutationDryRun(options?.dryRun);
    const sourceTarget = this.#resolve(source);
    const destinationTarget = this.#resolveNewTarget(destination);
    this.#assertExpectedHash(sourceTarget.path, options?.expectedSha256);
    this.#assertDoesNotExist(destinationTarget.path);
    const result: SafeFilesystemMutationResult = {
      operation: 'moveFile', path: destinationTarget.path, source: sourceTarget.path,
      destination: destinationTarget.path, planned: dryRun === 'plan',
    };
    if (dryRun === 'plan') {
      return result;
    }

    this.#recheckExistingRegularFile(sourceTarget);
    this.#recheckNewTarget(destinationTarget);
    this.#assertDoesNotExist(destinationTarget.path);
    renameSync(sourceTarget.path, destinationTarget.path);
    return result;
  }

  #assertActive(): void {
    if (isKillSwitchActive(this.#stateProvider)) {
      throw new FreeRdcError(E_KILLSWITCH);
    }
  }

  #resolve(candidate: string): ResolvedPath {
    if (!isAbsolutePath(candidate)) {
      throw escapeError();
    }
    if (isDenied(candidate)) {
      throw deniedError();
    }
    const lexicalPath = path.normalize(path.resolve(candidate));

    let realPath: string | undefined;
    try {
      realPath = realpathSync(candidate);
    } catch {
      // checkPath can still validate a non-existent candidate against its ancestor.
    }
    if (realPath !== undefined && isDenied(realPath)) {
      throw deniedError();
    }

    for (const root of this.#roots) {
      const checked = checkPath(root, candidate);
      if (checked.ok) {
        if (realPath !== undefined) {
          const realChecked = checkPath(root, realPath);
          if (!realChecked.ok) {
            throw realChecked.error === E_PATH_DENIED ? deniedError() : escapeError();
          }
        }
        return { path: lexicalPath, realPath };
      }
      if (checked.error === E_PATH_DENIED) {
        throw deniedError();
      }
    }
    throw escapeError();
  }

  #verifyUnchanged(resolved: ResolvedPath): void {
    if (resolved.realPath === undefined) {
      return;
    }
    const current = this.#resolve(resolved.path);
    if (current.realPath !== resolved.realPath) {
      throw escapeError();
    }
  }

  #resolveNewTarget(candidate: string): ResolvedPath {
    try {
      const target = this.#resolve(candidate);
      const parent = this.#resolve(path.dirname(target.path));
      const parentStats = lstatSync(parent.path);
      if (parentStats.isSymbolicLink() || !statSync(parent.path).isDirectory() || parent.realPath === undefined) {
        throw escapeError();
      }
      this.#verifyUnchanged(parent);
      return target;
    } catch (error) {
      if (error instanceof FreeRdcError) {
        throw error;
      }
      throw escapeError();
    }
  }

  #recheckNewTarget(target: ResolvedPath): void {
    const parent = this.#resolveNewTarget(target.path);
    this.#verifyUnchanged(parent);
  }

  #existingRegularFile(filePath: string): boolean {
    try {
      const linkStats = lstatSync(filePath);
      if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
        throw escapeError();
      }
      return true;
    } catch (error) {
      if (isFilesystemError(error) && error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  #assertDoesNotExist(filePath: string): void {
    if (this.#existingRegularFile(filePath)) {
      throw escapeError();
    }
  }

  #assertExpectedHash(filePath: string, expectedSha256: string | undefined): void {
    if (!isSha256(expectedSha256)) {
      throw staleHashError();
    }
    try {
      const descriptor = openNoFollow(filePath, fsConstants.O_RDONLY);
      try {
        const descriptorStats = fstatSync(descriptor);
        if (!descriptorStats.isFile()) {
          throw escapeError();
        }
        const actualSha256 = sha256Descriptor(descriptor);
        if (actualSha256 !== expectedSha256.toLowerCase()) {
          throw staleHashError();
        }
      } finally {
        closeSync(descriptor);
      }
    } catch (error) {
      if (error instanceof FreeRdcError) {
        throw error;
      }
      if (isFilesystemError(error) && error.code === 'ENOENT') {
        throw staleHashError();
      }
      throw escapeError();
    }
  }

  #recheckExistingRegularFile(target: ResolvedPath): void {
    this.#verifyUnchanged(target);
    if (!this.#existingRegularFile(target.path)) {
      throw escapeError();
    }
  }

  #writeFile(filePath: string, data: Buffer, overwriting: boolean, expectedSha256: string | undefined): void {
    const flags = overwriting
      ? fsConstants.O_RDWR
      : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
    const descriptor = openNoFollow(filePath, flags, 0o600);
    try {
      if (!fstatSync(descriptor).isFile()) {
        throw escapeError();
      }
      if (overwriting) {
        const actualSha256 = sha256Descriptor(descriptor);
        if (!isSha256(expectedSha256) || actualSha256 !== expectedSha256.toLowerCase()) {
          throw staleHashError();
        }
        // Opening without O_TRUNC lets us verify the no-follow descriptor first.
        ftruncateSync(descriptor, 0);
      }
      let offset = 0;
      while (offset < data.byteLength) {
        offset += writeSync(descriptor, data, offset, data.byteLength - offset, offset);
      }
    } finally {
      closeSync(descriptor);
    }
  }
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && path.isAbsolute(value);
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw escapeError();
  }
  return Math.floor(value);
}

function mutationDryRun(value: SafeFilesystemDryRun | undefined): SafeFilesystemDryRun {
  if (value === undefined || value === 'off') {
    return 'off';
  }
  if (value === 'plan') {
    return 'plan';
  }
  throw escapeError();
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-fA-F0-9]{64}$/u.test(value);
}

function openNoFollow(filePath: string, flags: number, mode?: number): number {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  return mode === undefined
    ? openSync(filePath, flags | noFollow)
    : openSync(filePath, flags | noFollow, mode);
}

const HASH_CHUNK_BYTES = 64 * 1024;

/** Hash an already validated descriptor without materializing the file. */
function sha256Descriptor(descriptor: number): string {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let bytesRead = 0;
  do {
    bytesRead = readSync(descriptor, chunk, 0, chunk.byteLength, null);
    if (bytesRead > 0) {
      hash.update(chunk.subarray(0, bytesRead));
    }
  } while (bytesRead > 0);
  return hash.digest('hex');
}

function entryFromPath(filePath: string): SafeFilesystemEntry {
  const stats = lstatSync(filePath);
  return {
    path: filePath,
    type: stats.isFile()
      ? 'file'
      : stats.isDirectory()
        ? 'directory'
        : stats.isSymbolicLink()
          ? 'symlink'
          : 'other',
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

function wouldExceedOutputLimit(
  entries: readonly SafeFilesystemEntry[],
  next: SafeFilesystemEntry,
  maxOutputBytes: number,
): boolean {
  // Reserve the longest boolean spelling so either final result fits its budget.
  return Buffer.byteLength(JSON.stringify({ entries: [...entries, next], truncated: false })) > maxOutputBytes;
}

function wouldExceedSearchOutputLimit(
  matches: readonly SafeFilesystemSearchMatch[],
  next: SafeFilesystemSearchMatch,
  maxOutputBytes: number,
): boolean {
  return Buffer.byteLength(JSON.stringify({ matches: [...matches, next], truncated: false })) > maxOutputBytes;
}

function countLiteralMatches(content: string, needle: string, caseSensitive: boolean): number {
  const haystack = caseSensitive ? content : content.toLocaleLowerCase();
  const target = caseSensitive ? needle : needle.toLocaleLowerCase();
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - target.length) {
    const found = haystack.indexOf(target, offset);
    if (found === -1) {
      break;
    }
    count += 1;
    offset = found + target.length;
  }
  return count;
}

function isUnsafeChildError(error: unknown): boolean {
  return error instanceof FreeRdcError &&
    (error.code === E_PATH_DENIED || error.code === E_PATH_ESCAPE);
}

function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function deniedError(): FreeRdcError {
  return new FreeRdcError(E_PATH_DENIED);
}

function escapeError(): FreeRdcError {
  return new FreeRdcError(E_PATH_ESCAPE);
}

function tooLargeError(): FreeRdcError {
  return new FreeRdcError(E_TOO_LARGE);
}

function staleHashError(): FreeRdcError {
  return new FreeRdcError(E_STALE_HASH);
}
