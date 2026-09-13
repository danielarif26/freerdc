import { realpathSync } from 'node:fs';
import path from 'node:path';

import type { CommandPlan } from './types.js';

/**
 * Evaluate CommandPlan against an allowlist. Never executes the plan.
 * Default deny: a command is allowed only when a rule matches the real
 * executable path, exact basename, and argv predicate.
 */

export type ArgvPredicate = (argv: readonly string[]) => boolean;

export interface CommandRule {
  readonly executable: string;
  readonly basename: string;
  readonly argv: ArgvPredicate;
}

export interface CommandPolicy {
  readonly rules: readonly CommandRule[];
  readonly killSwitchActive?: boolean;
}

export const POLICY_DENY_REASONS = Object.freeze([
  'empty-executable',
  'relative-executable',
  'nul-executable',
  'nul-arg',
  'env-assignment-executable',
  'kill-switch-active',
  'realpath-failure',
  'basename-mismatch',
  'argv-predicate-failure',
  'no-rule',
] as const);

export type PolicyDenyReason = (typeof POLICY_DENY_REASONS)[number];
export type PolicyReason = 'allow' | PolicyDenyReason;

export type PolicyDecision =
  | { readonly allowed: true; readonly reason: 'allow' }
  | { readonly allowed: false; readonly reason: PolicyDenyReason };

export const DEFAULT_COMMAND_POLICY: Readonly<CommandPolicy> = Object.freeze({
  rules: Object.freeze([] as CommandRule[]),
  killSwitchActive: false,
});

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SENSITIVE_ENV_KEY =
  /token|secret|password|passwd|authorization|cookie|apikey|api_key|credential|private_key|bearer|session/i;

function allow(): PolicyDecision {
  return { allowed: true, reason: 'allow' };
}

function deny(reason: PolicyDenyReason): PolicyDecision {
  return { allowed: false, reason };
}

function hasNul(value: string): boolean {
  return value.includes('\0');
}

function argvAccepted(predicate: ArgvPredicate, argv: readonly string[]): boolean {
  try {
    return predicate(argv) === true;
  } catch {
    return false;
  }
}

/**
 * Deny-reason order is a stable contract. Do not reorder casually.
 */
export function evaluateCommandPlan(
  plan: CommandPlan,
  policy: CommandPolicy = DEFAULT_COMMAND_POLICY,
): PolicyDecision {
  if (policy.killSwitchActive === true) {
    return deny('kill-switch-active');
  }

  const executable = plan.executable;
  if (typeof executable !== 'string' || executable.length === 0) {
    return deny('empty-executable');
  }
  if (hasNul(executable)) {
    return deny('nul-executable');
  }
  if (ENV_ASSIGNMENT.test(executable)) {
    return deny('env-assignment-executable');
  }
  if (!path.isAbsolute(executable)) {
    return deny('relative-executable');
  }

  if (!Array.isArray(plan.argv)) {
    return deny('argv-predicate-failure');
  }
  for (const arg of plan.argv) {
    if (typeof arg !== 'string' || hasNul(arg)) {
      return deny('nul-arg');
    }
  }

  let resolved: string;
  try {
    resolved = realpathSync(executable);
  } catch {
    return deny('realpath-failure');
  }

  const resolvedBasename = path.basename(resolved);
  const pathMatches: CommandRule[] = [];
  const basenameMatches: CommandRule[] = [];

  for (const rule of policy.rules) {
    if (rule.executable !== resolved) {
      continue;
    }
    pathMatches.push(rule);
    if (rule.basename !== resolvedBasename) {
      continue;
    }
    basenameMatches.push(rule);
    if (argvAccepted(rule.argv, plan.argv)) {
      return allow();
    }
  }

  if (pathMatches.length === 0) {
    return deny('no-rule');
  }
  if (basenameMatches.length === 0) {
    return deny('basename-mismatch');
  }
  return deny('argv-predicate-failure');
}

export function scrubEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    if (SENSITIVE_ENV_KEY.test(key)) {
      continue;
    }
    scrubbed[key] = value;
  }
  return scrubbed;
}
