#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { createFreeRdcRuntime } from './runtime.js';

interface CliOptions { roots: string[]; port: number; stateDir?: string }

function usage(): never {
  process.stderr.write('usage: freerdc-server --root <absolute-dir> [--root <absolute-dir> ...] [--port 8787] [--state-dir <absolute-dir>]\n');
  process.exit(2);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const roots: string[] = [];
  let port = 8787;
  let stateDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--root' && value !== undefined) { roots.push(resolve(value)); index += 1; continue; }
    if (arg === '--port' && value !== undefined && /^\d+$/.test(value)) { port = Number(value); index += 1; continue; }
    if (arg === '--state-dir' && value !== undefined) { stateDir = resolve(value); index += 1; continue; }
    if (arg === '--home-root') { roots.push(homedir()); continue; }
    usage();
  }
  if (roots.length === 0 || !Number.isInteger(port) || port < 0 || port > 65535) usage();
  return { roots, port, ...(stateDir === undefined ? {} : { stateDir }) };
}

const options = parseArgs(process.argv.slice(2));
const runtime = createFreeRdcRuntime(options);
let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await runtime.close();
};
process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });

try {
  const address = await runtime.start();
  process.stdout.write(`FreeRDC MCP listening on http://${address.host}:${address.port}/mcp\n`);
} catch (error) {
  await stop();
  const message = error instanceof Error ? error.message : 'FreeRDC startup failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
