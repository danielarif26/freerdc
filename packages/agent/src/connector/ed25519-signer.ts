import { sign, type KeyObject } from 'node:crypto';

/** Creates an Ed25519 signer over the exact protocol transcript bytes. */
export function createEd25519Signer(privateKey: KeyObject): (transcript: Buffer) => Buffer {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError('Signer key must be a private Ed25519 KeyObject');
  }
  return (transcript: Buffer) => sign(null, transcript, privateKey);
}
