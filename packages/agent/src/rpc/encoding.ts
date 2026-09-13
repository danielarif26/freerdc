import { E_MALFORMED_MESSAGE, FreeRdcError, WireBytes as WireBytesSchema, type WireBytes } from '@freerdc/protocol';

export function encodeWireBytes(input: Buffer | Uint8Array): WireBytes {
  const bytes = Buffer.from(input);
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').equals(bytes)) return { encoding: 'utf8', data: text };
  return { encoding: 'base64', data: bytes.toString('base64') };
}

export function decodeWireBytes(input: unknown): Buffer {
  const parsed = WireBytesSchema.safeParse(input);
  if (!parsed.success) throw new FreeRdcError(E_MALFORMED_MESSAGE);
  return Buffer.from(parsed.data.data, parsed.data.encoding);
}
