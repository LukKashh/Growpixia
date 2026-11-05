/**
 * GrowPixel Strict Canonical JSON Serialization Utility
 * 
 * Requirements:
 * - Recursively sort object keys in deterministic lexical order.
 * - Preserve array order.
 * - Reject NaN, Infinity, undefined, functions, symbols, and circular references.
 * - Normalize negative zero.
 * - Reject unsafe integers.
 */

export function toCanonicalString(payload: unknown, seen = new WeakSet()): string {
  // 1. Handle Null
  if (payload === null) return 'null';

  // 2. Handle Rejection of Undefined, Functions, Symbols
  if (payload === undefined || typeof payload === 'function' || typeof payload === 'symbol') {
    throw new Error(`CANONICAL_SERIALIZATION_ERROR: Unsupported type ${typeof payload}`);
  }

  // 3. Handle Numbers
  if (typeof payload === 'number') {
    if (!Number.isFinite(payload)) {
      throw new Error(`CANONICAL_SERIALIZATION_ERROR: Non-finite number ${payload} detected`);
    }
    // Reject unsafe integers for economy quantities
    if (Math.abs(payload) > Number.MAX_SAFE_INTEGER) {
      throw new Error(`CANONICAL_SERIALIZATION_ERROR: Unsafe integer ${payload} exceeds MAX_SAFE_INTEGER`);
    }
    // Normalize negative zero
    if (Object.is(payload, -0)) return '0';
    return JSON.stringify(payload);
  }

  // 4. Handle Booleans and Strings
  if (typeof payload === 'boolean' || typeof payload === 'string') {
    return JSON.stringify(payload);
  }

  // 5. Detect Circular References
  if (typeof payload === 'object') {
    if (seen.has(payload)) {
      throw new Error('CANONICAL_SERIALIZATION_ERROR: Circular reference detected');
    }
    seen.add(payload);
  }

  // 6. Handle Arrays
  if (Array.isArray(payload)) {
    const parts = payload.map(item => toCanonicalString(item, seen));
    return `[${parts.join(',')}]`;
  }

  // 7. Handle Plain Objects
  if (Object.prototype.toString.call(payload) === '[object Object]') {
    const keys = Object.keys(payload).sort();
    const parts = keys.map(key => {
      const val = (payload as Record<string, unknown>)[key];
      return `${JSON.stringify(key)}:${toCanonicalString(val, seen)}`;
    });
    return `{${parts.join(',')}}`;
  }

  // 8. Reject everything else (Dates, Maps, Sets, Class Instances)
  throw new Error(`CANONICAL_SERIALIZATION_ERROR: Unsupported object type ${Object.prototype.toString.call(payload)}`);
}
