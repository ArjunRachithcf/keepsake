import { createHash, randomBytes } from 'node:crypto';

/** 256 random bits, URL-safe. */
export const newToken = () => randomBytes(32).toString('base64url');
/** What the database keeps of a token (sessions, one-time links). */
export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
/** A token as it may arrive: base64url, 43 characters for ours; anything else is refused before it is hashed. */
export const looksLikeToken = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
/** A random id (128 bits, URL-safe, 22 characters) where a ULID's time would say too much (questions: ADR 0008). */
export const randomId = () => randomBytes(16).toString('base64url');
