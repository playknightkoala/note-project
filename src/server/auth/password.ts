import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
// N=2^15, r=8, p=3 is one of the equivalent settings OWASP lists for scrypt. It costs three times the time of p=1
// at the same 32 MB per hash, which matters more than peak memory in a single small container.
const PARAMS = { logN: 15, r: 8, p: 3, keyLength: 64, saltLength: 16 };
const MAX_MEMORY = 128 * 1024 * 1024;

/** Format: scrypt$logN$r$p$salt$hash (base64url). Parameters travel with the hash so cost can be raised later. */
export async function hashPassword(password: string, params = PARAMS): Promise<string> {
  const salt = randomBytes(params.saltLength);
  const key = await derive(password, salt, params.logN, params.r, params.p, params.keyLength);
  return ['scrypt', params.logN, params.r, params.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.logN, parsed.r, parsed.p, parsed.hash.length);
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}

/** True when the stored hash uses weaker parameters than the current defaults (re-hash on next login). */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.logN < PARAMS.logN || parsed.r < PARAMS.r || parsed.p < PARAMS.p;
}

// A real hash of a random secret; verifying unknown accounts against it keeps login timing uniform.
let dummyHash: string | null = null;
export async function dummyVerify(password: string): Promise<void> {
  dummyHash ??= await hashPassword(randomBytes(24).toString('base64url'));
  await verifyPassword(dummyHash, password);
}

function derive(password: string, salt: Buffer, logN: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize('NFC'), salt, keyLength, { N, r, p, maxmem: MAX_MEMORY }, (error, key) => error ? reject(error) : resolve(key));
  });
}

function parse(stored: string): { logN: number; r: number; p: number; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [logN, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![logN, r, p].every(Number.isInteger) || logN < 10 || logN > 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  return { logN, r, p, salt: Buffer.from(parts[4]!, 'base64url'), hash: Buffer.from(parts[5]!, 'base64url') };
}
