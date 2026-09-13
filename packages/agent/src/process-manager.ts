import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { Writable } from 'node:stream';

import { Semaphore } from '@freerdc/guard';
import { E_CMD_DENIED, E_CONCURRENCY_LIMIT, E_INTERNAL, E_KILLSWITCH, E_TOO_LARGE, FreeRdcError } from '@freerdc/protocol';

import { SafeFilesystem } from './filesystem.js';
import { isKillSwitchActive, type StateProvider } from './kill-switch.js';
import { evaluateCommandPlan, scrubEnv, type CommandPolicy } from './policy.js';
import { DEFAULT_AGENT_LIMITS, type AgentLimits, type CommandPlan } from './types.js';

export type ProcessStatus = 'running' | 'exited';

/** The deliberately non-sensitive view of an agent-owned child process. */
export interface ProcessSummary {
  readonly id: string;
  readonly status: ProcessStatus;
  readonly startedAt: string;
}

export interface ProcessReadResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** Bytes were dropped because the session output cap was exceeded. */
  readonly truncated: boolean;
  /** Bytes remain buffered after this read (or would remain after a peek). */
  readonly hasMore: boolean;
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** A validated command plan which was deliberately not executed. */
export interface PlannedProcessResult {
  readonly planned: true;
}

export interface ProcessManagerOptions {
  readonly roots: readonly string[];
  readonly policy: CommandPolicy;
  readonly limits?: Partial<AgentLimits>;
  readonly stateProvider?: StateProvider;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly maxSessions?: number;
}

export interface ProcessStartOptions {
  readonly signal?: AbortSignal;
}

interface Session {
  readonly id: string;
  readonly plan: CommandPlan;
  readonly child: ChildProcess;
  readonly startedAt: string;
  stdout: Buffer[];
  stderr: Buffer[];
  outputBytes: number;
  truncated: boolean;
  status: ProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  release: (() => void) | undefined;
  terminationGrace: NodeJS.Timeout | undefined;
  closed: boolean;
  stdinBackpressured: boolean;
  removeOnExit: boolean;
  abortSignal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
}

const TERMINATION_GRACE_MS = 50;
const DEFAULT_MAX_SESSIONS = 128;

/**
 * Runs only children created by this instance. It intentionally has no API for
 * discovering or signalling processes outside its own session map.
 */
export class ProcessManager {
  readonly #filesystem: SafeFilesystem;
  readonly #roots: readonly string[];
  readonly #policy: CommandPolicy;
  readonly #stateProvider?: StateProvider;
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;
  readonly #limits: Readonly<Pick<AgentLimits, 'maxWriteBytes' | 'maxOutputBytes' | 'commandTimeoutMs'>>;
  readonly #semaphore: Semaphore;
  readonly #sessions = new Map<string, Session>();
  readonly #maxSessions: number;
  #pendingStarts = 0;

  constructor(options: ProcessManagerOptions) {
    const maxWriteBytes = commandLimit(options.limits?.maxWriteBytes, DEFAULT_AGENT_LIMITS.maxWriteBytes);
    const maxOutputBytes = outputLimit(options.limits?.maxOutputBytes, DEFAULT_AGENT_LIMITS.maxOutputBytes);
    const commandTimeoutMs = commandLimit(options.limits?.commandTimeoutMs, DEFAULT_AGENT_LIMITS.commandTimeoutMs);
    const maxCommandConcurrency = commandLimit(
      options.limits?.maxCommandConcurrency,
      DEFAULT_AGENT_LIMITS.maxCommandConcurrency,
    );
    const maxSessions = commandLimit(options.maxSessions, DEFAULT_MAX_SESSIONS);
    this.#filesystem = new SafeFilesystem({
      roots: options.roots,
      limits: options.limits,
      stateProvider: options.stateProvider,
    });
    this.#roots = Object.freeze(options.roots.map((root) => this.#canonicalDirectory(root)));
    this.#policy = options.policy;
    this.#stateProvider = options.stateProvider;
    this.#baseEnv = options.baseEnv ?? process.env;
    this.#limits = Object.freeze({
      maxWriteBytes,
      maxOutputBytes,
      commandTimeoutMs,
    });
    this.#semaphore = new Semaphore(maxCommandConcurrency);
    this.#maxSessions = maxSessions;
  }

  async start(plan: CommandPlan & { readonly dryRun: 'plan' }, options?: ProcessStartOptions): Promise<PlannedProcessResult>;
  async start(plan: CommandPlan, options?: ProcessStartOptions): Promise<ProcessSummary>;
  async start(plan: CommandPlan, options: ProcessStartOptions = {}): Promise<ProcessSummary | PlannedProcessResult> {
    const dryRun = this.#dryRunFor(plan.dryRun);
    this.#prepare(plan);
    if (dryRun === 'plan') {
      return Object.freeze({ planned: true });
    }
    this.#evictExitedForCapacity();
    if (this.#sessions.size + this.#pendingStarts >= this.#maxSessions) {
      throw new FreeRdcError(E_CONCURRENCY_LIMIT);
    }
    this.#pendingStarts += 1;
    let release: (() => void) | undefined;
    let reserved = true;
    let sessionRegistered = false;
    try {
      release = await this.#semaphore.acquire();
      if (options.signal?.aborted) throw new FreeRdcError(E_CMD_DENIED, { reason: 'cancelled' });
      this.#evictExitedForCapacity();
      if (this.#sessions.size + this.#pendingStarts > this.#maxSessions) throw new FreeRdcError(E_CONCURRENCY_LIMIT);
      const current = this.#prepare(plan);
      if (options.signal?.aborted) throw new FreeRdcError(E_CMD_DENIED, { reason: 'cancelled' });
      const child = spawn(current.plan.executable, [...current.plan.argv], {
        cwd: current.cwd,
        env: scrubEnv(this.#baseEnv),
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const session: Session = {
        id: randomUUID(),
        plan: current.plan,
        child,
        startedAt: new Date().toISOString(),
        stdout: [],
        stderr: [],
        outputBytes: 0,
        truncated: false,
        status: 'running',
        exitCode: null,
        signal: null,
        release,
        terminationGrace: undefined,
        closed: false,
        stdinBackpressured: false,
        removeOnExit: false,
        abortSignal: options.signal,
        abortListener: undefined,
      };
      this.#sessions.set(session.id, session);
      sessionRegistered = true;
      // Keep the reservation counted until the session is visible in the map.
      this.#pendingStarts -= 1;
      reserved = false;
      this.#attach(session, current.timeoutMs);
      if (options.signal !== undefined) {
        const onAbort = () => this.#cancelStartedSession(session);
        session.abortListener = onAbort;
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        await this.#waitForSpawn(session, options.signal);
        if (options.signal?.aborted) throw new FreeRdcError(E_CMD_DENIED, { reason: 'cancelled' });
      } catch (error) {
        this.#cancelStartedSession(session);
        if (error instanceof FreeRdcError) throw error;
        throw new FreeRdcError(E_INTERNAL);
      }
      this.#detachAbortListener(session);
      return this.#summary(session);
    } catch (error) {
      if (reserved) {
        this.#pendingStarts -= 1;
        reserved = false;
      }
      // Once registered, #finish owns this release. This catch only owns a
      // semaphore permit acquired before registration completed.
      if (release !== undefined && !sessionRegistered) {
        release();
      }
      if (error instanceof FreeRdcError) {
        throw error;
      }
      throw new FreeRdcError(E_INTERNAL);
    }
  }

  read(id: string, maxBytes = this.#limits.maxOutputBytes): ProcessReadResult | undefined {
    const result = this.peek(id, maxBytes);
    if (result === undefined) return undefined;
    this.consume(id, result.stdout.byteLength, result.stderr.byteLength);
    return result;
  }

  /** Views a buffered prefix without consuming it, for response-size fitting. */
  peek(id: string, maxBytes = this.#limits.maxOutputBytes): ProcessReadResult | undefined {
    const session = this.#sessions.get(id);
    if (session === undefined) return undefined;
    const budget = this.#readBudget(maxBytes);
    const { stdoutBytes, stderrBytes } = splitReadBudget(session.stdout, session.stderr, budget);
    const stdout = peekChunks(session.stdout, stdoutBytes);
    const stderr = peekChunks(session.stderr, stderrBytes);
    const hasMore = bufferedBytes(session.stdout) > stdout.byteLength || bufferedBytes(session.stderr) > stderr.byteLength;
    return {
      stdout,
      stderr,
      truncated: session.truncated,
      hasMore,
      status: session.status,
      exitCode: session.exitCode,
      signal: session.signal,
    };
  }

  /** Consumes the exact prefixes previously returned by peek. */
  consume(id: string, stdoutBytes: number, stderrBytes: number): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined) return false;
    if (!Number.isSafeInteger(stdoutBytes) || stdoutBytes < 0 || !Number.isSafeInteger(stderrBytes) || stderrBytes < 0) {
      throw new FreeRdcError(E_TOO_LARGE);
    }
    if (stdoutBytes > bufferedBytes(session.stdout) || stderrBytes > bufferedBytes(session.stderr)) {
      throw new FreeRdcError(E_TOO_LARGE);
    }
    drainChunks(session.stdout, stdoutBytes);
    drainChunks(session.stderr, stderrBytes);
    if (session.status === 'exited' && session.stdout.length === 0 && session.stderr.length === 0) this.#sessions.delete(id);
    return true;
  }

  input(id: string, data: string | Buffer): boolean {
    this.#assertActive();
    const session = this.#sessions.get(id);
    if (session === undefined || session.status !== 'running' || !isWritableStdin(session.child.stdin)) {
      return false;
    }
    this.#assertAllowed(session.plan);
    if (session.stdinBackpressured) throw new FreeRdcError(E_CONCURRENCY_LIMIT);
    const input = toBuffer(data);
    if (input.byteLength > this.#limits.maxWriteBytes) {
      // A rejected write must not leave a child indefinitely waiting for more
      // stdin after its caller has received a terminal size-limit error.
      session.child.stdin.end();
      throw new FreeRdcError(E_TOO_LARGE);
    }
    try {
      // Writable.write(false) means the bytes were accepted but backpressure is active.
      // Do not report that as an offline/failure signal or callers may retry the same input.
      const belowHighWaterMark = session.child.stdin.write(input);
      if (!belowHighWaterMark) session.stdinBackpressured = true;
      return true;
    } catch {
      throw new FreeRdcError(E_INTERNAL);
    }
  }

  kill(id: string, force = false): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined || session.status !== 'running') {
      return false;
    }
    try {
      return session.child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      return false;
    }
  }

  list(): readonly ProcessSummary[] {
    return Object.freeze([...this.#sessions.values()].map((session) => this.#summary(session)));
  }

  killAll(force = false): void {
    for (const session of this.#sessions.values()) {
      if (session.status === 'running') {
        this.kill(session.id, force);
      }
    }
  }

  #attach(session: Session, timeoutMs: number): void {
    const timeout = setTimeout(() => this.#terminate(session), timeoutMs);
    session.child.stdout?.on('data', (chunk: Buffer) => this.#capture(session, 'stdout', chunk));
    session.child.stderr?.on('data', (chunk: Buffer) => this.#capture(session, 'stderr', chunk));
    session.child.stdin?.on('error', () => { session.stdinBackpressured = false; });
    session.child.stdin?.on('close', () => { session.stdinBackpressured = false; });
    session.child.stdin?.on('drain', () => { session.stdinBackpressured = false; });
    session.child.on('error', () => this.#finish(session, null, null, timeout));
    session.child.on('close', (exitCode, signal) => this.#finish(session, exitCode, signal, timeout));
  }

  #capture(session: Session, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    if (session.closed) {
      return;
    }
    const remaining = this.#limits.maxOutputBytes - session.outputBytes;
    if (remaining > 0) {
      const stored = chunk.subarray(0, remaining);
      session[stream].push(stored);
      session.outputBytes += stored.byteLength;
    }
    if (chunk.byteLength > remaining) {
      session.truncated = true;
      this.#terminate(session);
    }
  }

  #terminate(session: Session): void {
    if (session.status !== 'running') {
      return;
    }
    this.kill(session.id);
    if (session.terminationGrace !== undefined) {
      return;
    }
    session.terminationGrace = setTimeout(() => {
      session.terminationGrace = undefined;
      if (session.status === 'running') {
        this.kill(session.id, true);
      }
    }, TERMINATION_GRACE_MS);
  }

  #cancelStartedSession(session: Session): void {
    session.removeOnExit = true;
    if (session.closed) {
      this.#sessions.delete(session.id);
      return;
    }
    this.#terminate(session);
  }

  #waitForSpawn(session: Session, signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: FreeRdcError) => {
        if (settled) return;
        settled = true;
        session.child.removeListener('spawn', onSpawn);
        session.child.removeListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
        if (error === undefined) resolve(); else reject(error);
      };
      const onSpawn = () => finish();
      const onError = () => finish(new FreeRdcError(E_INTERNAL));
      const onAbort = () => finish(new FreeRdcError(E_CMD_DENIED, { reason: 'cancelled' }));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      session.child.once('spawn', onSpawn);
      session.child.once('error', onError);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #finish(session: Session, exitCode: number | null, signal: NodeJS.Signals | null, timeout: NodeJS.Timeout): void {
    if (session.closed) {
      return;
    }
    session.closed = true;
    session.stdinBackpressured = false;
    session.status = 'exited';
    session.exitCode = exitCode;
    session.signal = signal;
    clearTimeout(timeout);
    if (session.terminationGrace !== undefined) {
      clearTimeout(session.terminationGrace);
      session.terminationGrace = undefined;
    }
    session.release?.();
    session.release = undefined;
    this.#detachAbortListener(session);
    if (session.removeOnExit) this.#sessions.delete(session.id);
  }

  #evictExitedForCapacity(): void {
    while (this.#sessions.size + this.#pendingStarts >= this.#maxSessions) {
      const exited = [...this.#sessions.values()].find((session) => session.status === 'exited');
      if (exited === undefined) return;
      this.#sessions.delete(exited.id);
    }
  }

  #readBudget(maxBytes: number): number {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new FreeRdcError(E_TOO_LARGE);
    return Math.min(maxBytes, this.#limits.maxOutputBytes);
  }

  #detachAbortListener(session: Session): void {
    if (session.abortSignal !== undefined && session.abortListener !== undefined) {
      session.abortSignal.removeEventListener('abort', session.abortListener);
      session.abortListener = undefined;
    }
  }


  #assertActive(): void {
    if (isKillSwitchActive(this.#stateProvider)) {
      this.killAll(true);
      throw new FreeRdcError(E_KILLSWITCH);
    }
  }

  #assertAllowed(plan: CommandPlan): void {
    const decision = evaluateCommandPlan(plan, this.#policy);
    if (!decision.allowed) {
      throw new FreeRdcError(E_CMD_DENIED, { reason: decision.reason });
    }
  }

  #prepare(plan: CommandPlan): { readonly plan: CommandPlan; readonly cwd: string; readonly timeoutMs: number } {
    this.#assertActive();
    this.#assertAllowed(plan);
    const canonicalPlan = this.#canonicalPlan(plan);
    this.#assertAllowed(canonicalPlan);
    return Object.freeze({
      plan: canonicalPlan,
      cwd: this.#cwdFor(canonicalPlan),
      timeoutMs: this.#timeoutFor(canonicalPlan.timeoutMs),
    });
  }

  #canonicalPlan(plan: CommandPlan): CommandPlan {
    let executable: string;
    try {
      executable = realpathSync(plan.executable);
    } catch {
      throw new FreeRdcError(E_CMD_DENIED, { reason: 'realpath-failure' });
    }
    return Object.freeze({ ...plan, executable });
  }

  #cwdFor(plan: CommandPlan): string {
    const candidate = plan.cwd ?? this.#roots[0];
    if (candidate === undefined) {
      throw new FreeRdcError(E_INTERNAL);
    }
    return this.#canonicalDirectory(candidate);
  }

  #canonicalDirectory(candidate: string): string {
    this.#filesystem.stat(candidate);
    let canonical: string;
    try {
      canonical = realpathSync(candidate);
    } catch {
      throw new FreeRdcError(E_CMD_DENIED, { reason: 'invalid-cwd' });
    }
    const entry = this.#filesystem.stat(canonical);
    if (entry.type !== 'directory') {
      throw new FreeRdcError(E_CMD_DENIED, { reason: 'invalid-cwd' });
    }
    return canonical;
  }

  #timeoutFor(value: number | undefined): number {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new FreeRdcError(E_CMD_DENIED, { reason: 'invalid-timeout' });
    }
    return Math.min(value ?? this.#limits.commandTimeoutMs, this.#limits.commandTimeoutMs);
  }

  #dryRunFor(value: CommandPlan['dryRun']): 'off' | 'plan' {
    if (value === undefined || value === 'off' || value === 'plan') {
      return value ?? 'off';
    }
    throw new FreeRdcError(E_CMD_DENIED, { reason: 'invalid-dry-run' });
  }

  #summary(session: Session): ProcessSummary {
    return Object.freeze({ id: session.id, status: session.status, startedAt: session.startedAt });
  }
}

function drainChunks(chunks: Buffer[], maxBytes: number): Buffer {
  if (maxBytes <= 0 || chunks.length === 0) return Buffer.alloc(0);
  const drained: Buffer[] = [];
  let remaining = maxBytes;
  while (remaining > 0 && chunks.length > 0) {
    const first = chunks[0]!;
    if (first.byteLength <= remaining) {
      drained.push(first);
      chunks.shift();
      remaining -= first.byteLength;
      continue;
    }
    drained.push(first.subarray(0, remaining));
    chunks[0] = first.subarray(remaining);
    remaining = 0;
  }
  return Buffer.concat(drained);
}

function peekChunks(chunks: readonly Buffer[], maxBytes: number): Buffer {
  if (maxBytes <= 0 || chunks.length === 0) return Buffer.alloc(0);
  const viewed: Buffer[] = [];
  let remaining = maxBytes;
  for (const chunk of chunks) {
    if (remaining <= 0) break;
    const portion = chunk.subarray(0, remaining);
    viewed.push(portion);
    remaining -= portion.byteLength;
  }
  return Buffer.concat(viewed);
}

function bufferedBytes(chunks: readonly Buffer[]): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

function splitReadBudget(stdout: readonly Buffer[], stderr: readonly Buffer[], budget: number): { stdoutBytes: number; stderrBytes: number } {
  const stdoutAvailable = bufferedBytes(stdout);
  const stderrAvailable = bufferedBytes(stderr);
  if (stdoutAvailable === 0) return { stdoutBytes: 0, stderrBytes: Math.min(budget, stderrAvailable) };
  if (stderrAvailable === 0) return { stdoutBytes: Math.min(budget, stdoutAvailable), stderrBytes: 0 };
  if (budget === 1) return { stdoutBytes: 0, stderrBytes: 1 };

  // When both streams are ready, reserve a share for stderr so a noisy stdout
  // producer cannot indefinitely hide diagnostics. Any unused share goes to
  // the other stream.
  let stdoutBytes = Math.min(stdoutAvailable, Math.ceil(budget / 2));
  let stderrBytes = Math.min(stderrAvailable, budget - stdoutBytes);
  let remaining = budget - stdoutBytes - stderrBytes;
  if (remaining > 0) {
    const moreStdout = Math.min(remaining, stdoutAvailable - stdoutBytes);
    stdoutBytes += moreStdout;
    remaining -= moreStdout;
  }
  if (remaining > 0) stderrBytes += Math.min(remaining, stderrAvailable - stderrBytes);
  return { stdoutBytes, stderrBytes };
}

function isWritableStdin(stdin: Writable | null | undefined): stdin is Writable {
  return stdin !== undefined && stdin !== null && stdin.writable && !stdin.writableEnded && !stdin.destroyed;
}

function commandLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new FreeRdcError(E_CMD_DENIED, { reason: 'invalid-command-limit' });
}

function outputLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new FreeRdcError(E_CMD_DENIED, { reason: 'invalid-command-limit' });
}

function toBuffer(data: string | Buffer): Buffer {
  if (typeof data === 'string') {
    return Buffer.from(data);
  }
  if (Buffer.isBuffer(data)) {
    return data;
  }
  throw new FreeRdcError(E_CMD_DENIED, { reason: 'invalid-input' });
}
