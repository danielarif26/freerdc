import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_AGENT_LIMITS,
  DEFAULT_COMMAND_POLICY,
  evaluateCommandPlan,
  POLICY_DENY_REASONS,
  scrubEnv,
  type CommandPlan,
  type CommandPolicy,
  type CommandRule,
} from '../src/index.js';

const ALLOWED_EXECUTABLE = realpathSync(fileURLToPath(import.meta.url));
const ALLOWED_BASENAME = basename(ALLOWED_EXECUTABLE);

function plan(
  executable: string,
  argv: readonly string[] = ['status'],
): CommandPlan {
  return { executable, argv };
}

function policyWith(rules: readonly CommandRule[], killSwitchActive = false): CommandPolicy {
  return { rules, killSwitchActive };
}

function matchingRule(
  argv: CommandRule['argv'] = () => true,
  basenameOverride = ALLOWED_BASENAME,
): CommandRule {
  return {
    executable: ALLOWED_EXECUTABLE,
    basename: basenameOverride,
    argv,
  };
}

test('index exports policy APIs alongside existing agent types', () => {
  assert.equal(typeof evaluateCommandPlan, 'function');
  assert.equal(typeof scrubEnv, 'function');
  assert.equal(typeof DEFAULT_AGENT_LIMITS.maxReadBytes, 'number');
  assert.equal(Object.isFrozen(DEFAULT_COMMAND_POLICY), true);
  assert.deepEqual(DEFAULT_COMMAND_POLICY.rules, []);
});

test('evaluateCommandPlan default-denies when no rules exist', () => {
  const decision = evaluateCommandPlan(plan(ALLOWED_EXECUTABLE));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-rule');
});

test('evaluateCommandPlan denies empty executable', () => {
  const decision = evaluateCommandPlan(plan(''), policyWith([matchingRule()]));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'empty-executable');
});

test('evaluateCommandPlan denies relative executable', () => {
  for (const executable of ['./tool', 'tool', '../bin/tool']) {
    const decision = evaluateCommandPlan(plan(executable), policyWith([matchingRule()]));
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'relative-executable');
  }
});

test('evaluateCommandPlan denies NUL in executable before realpath', () => {
  const decision = evaluateCommandPlan(
    plan(`${ALLOWED_EXECUTABLE}\0-extra`),
    policyWith([matchingRule()]),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'nul-executable');
});

test('evaluateCommandPlan denies NUL in argv', () => {
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE, ['-c', 'echo\0oops']),
    policyWith([matchingRule()]),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'nul-arg');
});

test('evaluateCommandPlan denies env-assignment executable', () => {
  for (const executable of ['FOO=bar', 'PATH=/tmp', 'A=B']) {
    const decision = evaluateCommandPlan(plan(executable), policyWith([matchingRule()]));
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'env-assignment-executable');
  }
});

test('evaluateCommandPlan denies when killSwitchActive is set', () => {
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE),
    policyWith([matchingRule()], true),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'kill-switch-active');
});

test('evaluateCommandPlan kill switch wins over an otherwise allowable plan', () => {
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE, ['status']),
    policyWith([matchingRule()], true),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'kill-switch-active');
});

test('evaluateCommandPlan denies realpath failure', () => {
  const missing = join(tmpdir(), '.no-such-freerdc-policy-executable');
  const decision = evaluateCommandPlan(plan(missing), policyWith([matchingRule()]));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'realpath-failure');
});

test('evaluateCommandPlan denies basename mismatch', () => {
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE),
    policyWith([matchingRule(() => true, 'not-the-real-basename')]),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'basename-mismatch');
});

test('evaluateCommandPlan denies argv predicate failure', () => {
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE, ['diff']),
    policyWith([matchingRule((argv) => argv[0] === 'status')]),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'argv-predicate-failure');
});

test('evaluateCommandPlan denies non-array argv', () => {
  const malformed = {
    executable: ALLOWED_EXECUTABLE,
    argv: 'status --short',
  } as unknown as CommandPlan;
  const decision = evaluateCommandPlan(malformed, policyWith([matchingRule()]));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'argv-predicate-failure');
});

test('evaluateCommandPlan denies when no rule matches the real path', () => {
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE),
    policyWith([
      {
        executable: join(tmpdir(), '.other-policy-executable'),
        basename: ALLOWED_BASENAME,
        argv: () => true,
      },
    ]),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-rule');
});

test('evaluateCommandPlan allows only when path, basename, and argv match', () => {
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE, ['status', '--short']),
    policyWith([
      matchingRule(
        (argv) =>
          argv.length === 2 && argv[0] === 'status' && argv[1] === '--short',
      ),
    ]),
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'allow');
});

test('evaluateCommandPlan allow does not spawn or mutate the plan', () => {
  const input: CommandPlan = Object.freeze({
    executable: ALLOWED_EXECUTABLE,
    argv: Object.freeze(['status']),
  });
  const decision = evaluateCommandPlan(input, policyWith([matchingRule()]));
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'allow');
  assert.deepEqual(input.argv, ['status']);
  assert.equal(input.executable, ALLOWED_EXECUTABLE);
});

test('evaluateCommandPlan uses argv as an array and does not join a shell string', () => {
  const seen: string[][] = [];
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE, ['status', '--short']),
    policyWith([
      matchingRule((argv) => {
        seen.push([...argv]);
        return Array.isArray(argv) && argv.join(' ') === 'status --short';
      }),
    ]),
  );
  assert.equal(decision.allowed, true);
  assert.deepEqual(seen, [['status', '--short']]);
});

test('evaluateCommandPlan allows a later rule after an earlier argv failure', () => {
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE, ['diff']),
    policyWith([
      matchingRule((argv) => argv[0] === 'status'),
      matchingRule((argv) => argv[0] === 'diff'),
    ]),
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'allow');
});

test('evaluateCommandPlan treats a throwing argv predicate as failure', () => {
  const decision = evaluateCommandPlan(
    plan(ALLOWED_EXECUTABLE),
    policyWith([
      matchingRule(() => {
        throw new Error('predicate exploded');
      }),
    ]),
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'argv-predicate-failure');
});

test('evaluateCommandPlan deny reasons are the frozen stable set', () => {
  assert.deepEqual([...POLICY_DENY_REASONS], [
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
  ]);
});

test('scrubEnv removes case-insensitive sensitive keys', () => {
  const input = {
    TOKEN: 'a',
    my_secret: 'b',
    Password: 'c',
    PASSWD: 'd',
    HTTP_AUTHORIZATION: 'e',
    Cookie: 'f',
    APIKEY: 'g',
    MY_API_KEY: 'h',
    credential: 'i',
    id_private_key: 'j',
    Bearer: 'k',
    SESSION_ID: 'l',
    PATH: '/usr/bin',
    HOME: '/home/user',
    USER: 'nobody',
    NODE_ENV: 'test',
    DEVICE_ID: 'keep-me',
  };
  const result = scrubEnv(input);
  assert.deepEqual(result, {
    PATH: '/usr/bin',
    HOME: '/home/user',
    USER: 'nobody',
    NODE_ENV: 'test',
    DEVICE_ID: 'keep-me',
  });
});

test('scrubEnv preserves ordinary keys and does not mutate input', () => {
  const input = Object.freeze({
    PATH: '/bin',
    LANG: 'C',
    SECRET_TOKEN: 'nope',
    EMPTY: '',
  });
  const snapshot = { ...input };
  const result = scrubEnv(input);
  assert.deepEqual(result, { PATH: '/bin', LANG: 'C', EMPTY: '' });
  assert.deepEqual({ ...input }, snapshot);
  assert.equal(Object.isFrozen(input), true);
  assert.notEqual(result, input);
});

test('scrubEnv skips undefined values without throwing', () => {
  const result = scrubEnv({ PATH: '/bin', UNUSED: undefined, TOKEN: 'x' });
  assert.deepEqual(result, { PATH: '/bin' });
});
