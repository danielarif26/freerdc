export type DryRunMode = 'off' | 'plan';

export interface AgentLimits {
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;
  readonly maxSearchBytes: number;
  readonly maxOutputBytes: number;
  readonly maxSearchResults: number;
  readonly commandTimeoutMs: number;
  readonly maxFilesystemConcurrency: number;
  readonly maxCommandConcurrency: number;
}

export const DEFAULT_AGENT_LIMITS: Readonly<AgentLimits> = Object.freeze({
  maxReadBytes: 1_048_576,
  maxWriteBytes: 1_048_576,
  maxSearchBytes: 4_194_304,
  maxOutputBytes: 262_144,
  maxSearchResults: 100,
  commandTimeoutMs: 30_000,
  maxFilesystemConcurrency: 4,
  maxCommandConcurrency: 2,
});

export interface FileMutationPlan {
  readonly path: string;
  readonly operation: 'create' | 'update' | 'delete';
  readonly byteLength?: number;
}

export interface CommandPlan {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly dryRun?: DryRunMode;
}

export interface AuditEvent {
  readonly timestamp: string;
  readonly action: 'file-mutation' | 'command';
  readonly outcome: 'planned' | 'started' | 'succeeded' | 'failed';
  readonly dryRun: boolean;
  readonly resource?: string;
  readonly errorCode?: string;
}
