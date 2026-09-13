import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AGENT_LIMITS,
  type AuditEvent,
  type CommandPlan,
  type DryRunMode,
} from '../src/index.js';

test('default agent limits are positive and frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_AGENT_LIMITS), true);
  for (const value of Object.values(DEFAULT_AGENT_LIMITS)) {
    assert.equal(typeof value, 'number');
    assert.ok(value > 0);
  }
});

test('command plans have executable and argv as an array', () => {
  const plan: CommandPlan = {
    executable: '/usr/bin/git',
    argv: ['status', '--short'],
  };
  assert.equal(typeof plan.executable, 'string');
  assert.ok(Array.isArray(plan.argv));
  assert.deepEqual(plan.argv, ['status', '--short']);
});

test('command plans support dry-run mode', () => {
  const plan: CommandPlan = {
    executable: '/usr/bin/git',
    argv: ['status', '--short'],
    dryRun: 'plan',
  };
  assert.equal(plan.dryRun, 'plan');
});

test('audit events exclude argv and message at runtime', () => {
  const event: AuditEvent = {
    timestamp: '2024-01-01T00:00:00.000Z',
    action: 'command',
    outcome: 'planned',
    dryRun: false,
    resource: '/usr/bin/git',
  };
  const keys = Object.keys(event);
  assert.ok(!keys.includes('argv'));
  assert.ok(!keys.includes('message'));
  assert.ok(!keys.includes('environment'));
  assert.ok(!keys.includes('credentials'));
});

test('audit events can be instantiated with all allowed properties', () => {
  const event: AuditEvent = {
    timestamp: '2024-01-01T00:00:00.000Z',
    action: 'file-mutation',
    outcome: 'succeeded',
    dryRun: true,
    resource: 'example.txt',
    errorCode: undefined,
  };
  assert.equal(event.timestamp, '2024-01-01T00:00:00.000Z');
  assert.equal(event.action, 'file-mutation');
  assert.equal(event.outcome, 'succeeded');
  assert.equal(event.dryRun, true);
  assert.equal(event.resource, 'example.txt');
  assert.equal(event.errorCode, undefined);
});
