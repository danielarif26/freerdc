export type DeviceStatus = 'online' | 'offline';

export interface DeviceRegistration {
  id: string;
  displayName?: string;
  capabilities: readonly string[];
}

export interface DeviceRecord extends DeviceRegistration {
  status: DeviceStatus;
  registeredAt: string;
  lastSeenAt: string;
}

type Clock = () => Date;

const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const REGISTRATION_KEYS = new Set(['id', 'displayName', 'capabilities']);

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>();

  constructor(private readonly clock: Clock = () => new Date()) {}

  register(input: DeviceRegistration): DeviceRecord {
    this.validateRegistration(input);

    if (this.devices.has(input.id)) {
      throw new Error(`Device already registered: ${input.id}`);
    }

    const timestamp = this.clock().toISOString();
    const record: DeviceRecord = {
      id: input.id,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      capabilities: this.normalizeCapabilities(input.capabilities),
      status: 'online',
      registeredAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.devices.set(record.id, record);
    return this.copy(record);
  }

  heartbeat(id: string): DeviceRecord | undefined {
    const record = this.devices.get(id);
    if (!record) {
      return undefined;
    }

    const updated: DeviceRecord = {
      ...record,
      status: 'online',
      lastSeenAt: this.clock().toISOString(),
    };
    this.devices.set(id, updated);
    return this.copy(updated);
  }

  markOffline(id: string): DeviceRecord | undefined {
    const record = this.devices.get(id);
    if (!record) {
      return undefined;
    }

    const updated: DeviceRecord = { ...record, status: 'offline' };
    this.devices.set(id, updated);
    return this.copy(updated);
  }

  unregister(id: string): boolean {
    return this.devices.delete(id);
  }

  get(id: string): DeviceRecord | undefined {
    const record = this.devices.get(id);
    return record === undefined ? undefined : this.copy(record);
  }

  list(): readonly DeviceRecord[] {
    return Object.freeze(
      [...this.devices.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((record) => this.copy(record)),
    );
  }

  private validateRegistration(input: DeviceRegistration): void {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('Device registration must be an object');
    }

    for (const key of Object.keys(input)) {
      if (!REGISTRATION_KEYS.has(key)) {
        throw new TypeError(`Unknown device registration property: ${key}`);
      }
    }

    if (!this.isConservativeString(input.id, 128)) {
      throw new TypeError('Device id must be 1 to 128 conservative printable characters');
    }
    if (
      input.displayName !== undefined &&
      (typeof input.displayName !== 'string' ||
        input.displayName.length < 1 ||
        input.displayName.length > 128 ||
        /[\x00-\x1F\x7F]/.test(input.displayName))
    ) {
      throw new TypeError('Device displayName must be 1 to 128 printable characters without control characters');
    }
    if (!Array.isArray(input.capabilities) || input.capabilities.length > 64) {
      throw new TypeError('Device capabilities must be an array of at most 64 entries');
    }
    for (const capability of input.capabilities) {
      if (!this.isConservativeString(capability, 128)) {
        throw new TypeError('Each capability must be 1 to 128 conservative printable characters');
      }
    }
  }

  private isConservativeString(value: unknown, maximumLength: number): value is string {
    return typeof value === 'string' && value.length >= 1 && value.length <= maximumLength && ID_PATTERN.test(value);
  }

  private normalizeCapabilities(capabilities: readonly string[]): readonly string[] {
    return Object.freeze([...new Set(capabilities)].sort());
  }

  private copy(record: DeviceRecord): DeviceRecord {
    return Object.freeze({
      ...record,
      capabilities: Object.freeze([...record.capabilities]),
    });
  }
}
