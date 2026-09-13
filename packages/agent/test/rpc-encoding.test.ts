import assert from 'node:assert/strict';
import test from 'node:test';
import { E_MALFORMED_MESSAGE, FreeRdcError } from '@freerdc/protocol';
import { decodeWireBytes, encodeWireBytes } from '../src/rpc/encoding.js';

const SENTINEL = 'WIRE_SECRET_SENTINEL';

test('encodeWireBytes uses utf8 only for exact UTF-8 round trips', () => {
  for (const text of ['hello', 'Hello, 世界', 'H\u0000i', '']) {
    const input = Buffer.from(text, 'utf8');
    const encoded = encodeWireBytes(input);
    assert.deepEqual(encoded, { encoding: 'utf8', data: text });
    assert.deepEqual(decodeWireBytes(encoded), input);
  }
});

test('encodeWireBytes uses canonical padded base64 for non-UTF8 bytes', () => {
  const input = Buffer.from([0xc3, 0x28]);
  const encoded = encodeWireBytes(input);
  assert.deepEqual(encoded, { encoding: 'base64', data: input.toString('base64') });
  assert.deepEqual(decodeWireBytes(encoded), input);
});

test('all byte values survive JSON serialization exactly', () => {
  const input = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const decoded = decodeWireBytes(JSON.parse(JSON.stringify(encodeWireBytes(input))));
  assert.deepEqual(decoded, input);
});

test('Uint8Array input is copied and never mutated', () => {
  const input = new Uint8Array([0xff, 0x00, 0x61]);
  const before = new Uint8Array(input);
  const encoded = encodeWireBytes(input);
  assert.deepEqual(input, before);
  assert.deepEqual(decodeWireBytes(encoded), Buffer.from(before));
});

test('decodeWireBytes accepts canonical base64', () => {
  assert.deepEqual(decodeWireBytes({ encoding: 'base64', data: 'YQ==' }), Buffer.from('a'));
});

test('decodeWireBytes maps malformed inputs to sanitized E_MALFORMED_MESSAGE', () => {
  const malformed: readonly unknown[] = [
    null,
    {},
    { encoding: 'hex', data: '61' },
    { encoding: 'utf8', data: 123 },
    { encoding: 'base64', data: 'YQ' },
    { encoding: 'utf8', data: 'ok', extra: SENTINEL },
    { encoding: 'utf8', data: '\uD800' },
  ];
  for (const input of malformed) {
    assert.throws(() => decodeWireBytes(input), (error: unknown) => {
      assert.ok(error instanceof FreeRdcError);
      assert.equal(error.code, E_MALFORMED_MESSAGE);
      assert.equal(error.details, undefined);
      assert.equal(error.message, E_MALFORMED_MESSAGE);
      assert.equal(error.message.includes(SENTINEL), false);
      assert.equal(JSON.stringify(error).includes(SENTINEL), false);
      return true;
    });
  }
});

test('decodeWireBytes explicitly rejects lone surrogate UTF-8 with sanitized E_MALFORMED_MESSAGE', () => {
  // Explicit test for the lone surrogate case - ensures it's caught by WireBytes schema
  assert.throws(() => decodeWireBytes({ encoding: 'utf8', data: '\uD800' }), (error: unknown) => {
    assert.ok(error instanceof FreeRdcError);
    assert.equal(error.code, E_MALFORMED_MESSAGE);
    assert.equal(error.details, undefined);
    assert.equal(error.message, E_MALFORMED_MESSAGE);
    return true;
  });
});
