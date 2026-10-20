// Safe reads and writes of object properties whose name comes from data —
// a setting name from a request, a status word, a key from a lookup table.
//
// Why: in JavaScript, obj[name] with a name like "__proto__" or
// "constructor" reaches built-in machinery shared by every object instead of
// the object's own data ("prototype pollution"). These helpers only ever
// touch an object's own properties, and refuse the dangerous names when
// writing, so a crafted name can't read or change anything else. They're
// used everywhere a property name isn't fixed in the code.

// Names that refer to JavaScript's object machinery rather than data.
const BLOCKED = new Set(["__proto__", "prototype", "constructor"]);

/**
 * The object's own value for a key, or undefined — never an inherited one.
 *
 * @param obj the object (null/undefined give undefined)
 * @param key the property name or array index
 */
export function own<T>(obj: Readonly<Record<string, T>> | ReadonlyArray<T> | null | undefined, key: string | number): T | undefined {
  if (obj == null) return undefined;
  const k = String(key);
  return Object.hasOwn(obj, k) ? (Reflect.get(obj, k) as T) : undefined;
}

/**
 * Sets the object's own property. Dangerous names are ignored.
 *
 * @param obj the object to change
 * @param key the property name
 * @param value the value to store
 */
export function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  if (BLOCKED.has(key)) return;
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Removes the object's own property, if it has one.
 *
 * @param obj the object to change
 * @param key the property name
 */
export function deleteOwn(obj: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(obj, key)) Reflect.deleteProperty(obj, key);
}
