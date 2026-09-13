import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A source of the agent kill-switch state. */
export interface StateProvider {
  isActive(): boolean;
}

/**
 * Reads the STOP sentinel without creating or modifying any filesystem state.
 */
export class FileStateProvider implements StateProvider {
  readonly stopFilePath: string;

  constructor(stopFilePath = join(homedir(), '.freerdc', 'STOP')) {
    this.stopFilePath = stopFilePath;
  }

  isActive(): boolean {
    try {
      statSync(this.stopFilePath);
      return true;
    } catch (error: unknown) {
      if (isMissingPathError(error)) {
        return false;
      }
      throw error;
    }
  }
}

/** A deterministic state provider for callers and tests that do not use disk. */
export class InMemoryStateProvider implements StateProvider {
  #active: boolean;

  constructor(active = false) {
    this.#active = active;
  }

  isActive(): boolean {
    return this.#active;
  }

  setActive(active: boolean): void {
    this.#active = active;
  }
}

/**
 * Returns true when the kill switch is active. Provider failures fail closed.
 */
export function isKillSwitchActive(provider?: StateProvider): boolean {
  try {
    return (provider ?? new FileStateProvider()).isActive();
  } catch {
    return true;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
