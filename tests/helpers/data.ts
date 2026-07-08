/**
 * Dynamic test-data generators for Playwright tests.
 *
 * Recorded form tests tend to hardcode the literal values you typed while
 * clicking through — which breaks on re-run (e.g. "email already exists" on a
 * signup form). Use these helpers to submit fresh, unique inputs each run.
 *
 * Dependency-free on purpose: no faker, no npm — just Date.now(), Math.random()
 * and built-ins, so it stays in step with the zero-dependency house style.
 * (Date.now()/Math.random() are banned in workflow scripts, not in test code.)
 *
 * Usage:
 *   import { uniqueEmail } from '../helpers/data';
 */

// Small, generic, international name pools — not real people, no PII.
const FIRST_NAMES = [
  'Alex', 'Sofia', 'Liam', 'Noor', 'Yuki', 'Mateo', 'Aisha', 'Kai',
  'Elena', 'Omar', 'Mia', 'Arjun', 'Chloe', 'Diego', 'Freya',
];

const LAST_NAMES = [
  'Andersen', 'Silva', 'Kim', 'Okafor', 'Rossi', 'Haddad', 'Nguyen', 'Meyer',
  'Kowalski', 'Tanaka', 'Ferreira', 'Novak', 'Costa', 'Ivanov', 'Bauer',
];

/**
 * A collision-resistant token, safe to embed in usernames, slugs, etc.
 * Combines the current time (base36) with a short random suffix.
 *
 * @param prefix leading label for the token (default `'gr'`)
 * @returns e.g. `"gr-lz4k9p-a7f3"`
 */
export function unique(prefix = 'gr'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomString(4).toLowerCase()}`;
}

/**
 * A unique email that still routes to a single real inbox via the plus-address
 * trick (`local+tag@domain`). Great for signup forms that reject duplicates.
 *
 * @param local the inbox local-part before the `+` (default `'user'`)
 * @param domain the mail domain (default `'example.com'`)
 * @returns e.g. `"user+gr-lz4k9p-a7f3@example.com"`
 */
export function uniqueEmail(local = 'user', domain = 'example.com'): string {
  return `${local}+${unique()}@${domain}`;
}

/** A plausible first name from the built-in pool. */
export function randomFirstName(): string {
  return pick(FIRST_NAMES);
}

/** A plausible last name from the built-in pool. */
export function randomLastName(): string {
  return pick(LAST_NAMES);
}

/** A plausible `"First Last"` full name from the built-in pools. */
export function randomName(): string {
  return `${randomFirstName()} ${randomLastName()}`;
}

/**
 * A plausible-format phone number using the reserved 555 exchange, so it's
 * shaped like a real US number but never dials a real line.
 *
 * @returns e.g. `"(555) 214-8830"`
 */
export function randomPhone(): string {
  const prefix = randomInt(200, 999); // 3-digit exchange (avoids leading 0/1)
  const line = randomInt(0, 9999).toString().padStart(4, '0');
  return `(555) ${prefix}-${line}`;
}

/**
 * A random alphanumeric string of the given length.
 *
 * @param n length of the string (default `10`)
 */
export function randomString(n = 10): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < n; i++) out += chars[randomInt(0, chars.length - 1)];
  return out;
}

/**
 * A random integer between `min` and `max`, inclusive.
 *
 * @param min lower bound (inclusive)
 * @param max upper bound (inclusive)
 */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * A random element from a non-empty array.
 *
 * @param items the array to pick from
 */
export function pick<T>(items: T[]): T {
  return items[randomInt(0, items.length - 1)];
}

/**
 * A strong random password suitable for signup forms: mixed case, digits and
 * at least one symbol, so it clears typical complexity rules.
 *
 * @param n total length (default `16`, clamped to a minimum of `8`)
 * @returns e.g. `"Kq7mZ!a3Rp1vLw9X"`
 */
export function password(n = 16): string {
  const len = Math.max(8, n);
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const symbols = '!@#$%^&*-_?';
  // Guarantee one of each required class, then fill the rest from all classes.
  const required = [pick(upper.split('')), pick(lower.split('')), pick(digits.split('')), pick(symbols.split(''))];
  const all = (upper + lower + digits + symbols).split('');
  const chars = [...required];
  for (let i = chars.length; i < len; i++) chars.push(pick(all));
  // Shuffle so the required characters aren't always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
