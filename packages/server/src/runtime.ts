import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  DEFAULT_AGENT_LIMITS,
  FileStateProvider,
  SafeFilesystem,
  isKillSwitchActive,
} from '@freerdc/agent';
import { isDenied } from '@freerdc/guard';

import { HashChainAuditLog } from './audit.js';
import { DeviceRegistry } from './device-registry.js';
import { createMcpHttpHost, DEFAULT_MCP_HTTP_PORT, type McpHttpAddress } from './http-host.js';
import { createFreeRdcMcpServer } from './mcp-server.js';

const DEFAULT_STATE_DIR = join(homedir(), '.freerdc');
const DEFAULT_AUDIT_FILE = 'audit.jsonl';

export interface FreeRdcRuntimeOptions {
  readonly roots: readonly string[];
  readonly port?: number;
  readonly stateDir?: string;
}

export class FreeRdcRuntime {
  readonly roots: readonly string[];
  readonly stateDir: string;
  readonly stopFilePath: string;
  readonly auditFilePath: string;

  private readonly stateProvider: FileStateProvider;
  private readonly filesystem: SafeFilesystem;
  private readonly auditLog: HashChainAuditLog;
  private readonly registry = new DeviceRegistry();
  private readonly host;
  private started = false;
  private closed = false;

  constructor(options: FreeRdcRuntimeOptions) {
    if (!Array.isArray(options.roots) || options.roots.length === 0) {
      throw new TypeError('roots must contain at least one absolute directory');
    }
    this.roots = Object.freeze(options.roots.map((root) => {
      if (typeof root !== 'string' || !isAbsolute(root)) {
        throw new TypeError('each root must be an absolute directory');
      }
      return resolve(root);
    }));
    this.stateDir = prepareStateDirectory(options.stateDir ?? DEFAULT_STATE_DIR, this.roots);
    this.stopFilePath = join(this.stateDir, 'STOP');
    this.auditFilePath = join(this.stateDir, DEFAULT_AUDIT_FILE);
    this.stateProvider = new FileStateProvider(this.stopFilePath);
    this.filesystem = new SafeFilesystem({ roots: this.roots, stateProvider: this.stateProvider });
    this.auditLog = new HashChainAuditLog(this.auditFilePath);

    const port = options.port ?? DEFAULT_MCP_HTTP_PORT;
    this.host = createMcpHttpHost(() => createFreeRdcMcpServer({
      filesystem: this.filesystem,
      auditLog: this.auditLog,
      deviceRegistry: this.registry,
      systemHealth: () => ({
        version: '0.1.0',
        healthy: !isKillSwitchActive(this.stateProvider),
        killSwitchActive: isKillSwitchActive(this.stateProvider),
        filesystemEnabled: true,
        processEnabled: false,
        auditEnabled: true,
        deviceCount: this.registry.list().length,
        onlineDeviceCount: this.registry.list().filter((device) => device.status === 'online').length,
        processCount: 0,
        capabilities: ['fs.v1', 'dryrun.v1', 'audit.v1'],
      }),
      policyDescription: {
        commandRuleCount: 0,
        limits: DEFAULT_AGENT_LIMITS,
        capabilities: ['fs.v1', 'dryrun.v1', 'audit.v1'],
      },
    }), port);
  }

  async start(): Promise<McpHttpAddress> {
    if (this.started || this.closed) throw new Error('FreeRDC runtime is already started or closed');
    const address = await this.host.start();
    this.started = true;
    return address;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.host.close();
    } finally {
      this.auditLog.close();
    }
  }
}

export function createFreeRdcRuntime(options: FreeRdcRuntimeOptions): FreeRdcRuntime {
  return new FreeRdcRuntime(options);
}

function prepareStateDirectory(candidate: string, roots: readonly string[]): string {
  if (!isAbsolute(candidate)) throw new TypeError('stateDir must be absolute');
  const stateDir = resolve(candidate);
  // The runtime is the sole owner of its exact default state directory. The
  // guard still denies that directory and every descendant to MCP filesystem
  // tools, while custom state locations remain subject to the full denylist.
  if (stateDir !== DEFAULT_STATE_DIR && isDenied(stateDir)) {
    throw new Error('stateDir is protected by policy');
  }
  const parent = dirname(stateDir);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('stateDir parent must be a non-symlink directory');
  }
  if (stateDir !== DEFAULT_STATE_DIR && overlapsFilesystemRoot(stateDir, parent, roots)) {
    throw new Error('stateDir must not overlap a filesystem root');
  }
  try {
    const stat = lstatSync(stateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('stateDir must be a non-symlink directory');
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(stateDir, { mode: 0o700 });
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const directoryOnly = fsConstants.O_DIRECTORY ?? 0;
  const descriptor = openSync(stateDir, fsConstants.O_RDONLY | noFollow | directoryOnly);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory()) throw new Error('stateDir must be a non-symlink directory');
    fchmodSync(descriptor, 0o700);
  } finally {
    closeSync(descriptor);
  }
  return stateDir;
}

function pathsOverlap(first: string, second: string): boolean {
  return isSameOrDescendant(first, second) || isSameOrDescendant(second, first);
}

function overlapsFilesystemRoot(stateDir: string, parent: string, roots: readonly string[]): boolean {
  // The parent has passed the non-symlink lstat check above. Resolving it also
  // catches a configured root that reaches the state directory through an
  // ancestor symlink, including before a new state directory is created.
  const statePaths = [stateDir, resolve(join(realpathSync(parent), basename(stateDir)))];
  return roots.some((root) => rootComparisonPaths(root).some((rootPath) => (
    statePaths.some((statePath) => pathsOverlap(statePath, rootPath))
  )));
}

function rootComparisonPaths(root: string): readonly string[] {
  try {
    return [root, resolve(realpathSync(root))];
  } catch {
    // SafeFilesystem reports invalid roots separately. The resolved lexical
    // root remains sufficient for overlap checks before that validation.
    return [root];
  }
}

function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  const comparisonCandidate = isCaseInsensitivePathPlatform() ? candidate.toLowerCase() : candidate;
  const comparisonAncestor = isCaseInsensitivePathPlatform() ? ancestor.toLowerCase() : ancestor;
  const pathFromAncestor = relative(comparisonAncestor, comparisonCandidate);
  return pathFromAncestor === ''
    || (pathFromAncestor !== '..' && !pathFromAncestor.startsWith(`..${sep}`) && !isAbsolute(pathFromAncestor));
}

function isCaseInsensitivePathPlatform(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}
