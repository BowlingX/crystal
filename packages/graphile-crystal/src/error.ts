export interface CrystalError extends Error {
  originalError: Error;
}

// IMPORTANT: this WILL NOT WORK when compiled down to ES5. It requires ES6+
// native class support.
/**
 * When an error occurs during plan execution we wrap it in a CrystalError so
 * that we can pass it around as a value.  It gets unwrapped and thrown in the
 * crystal resolver.
 *
 * @internal
 */
class _CrystalError extends Error implements CrystalError {
  public readonly originalError: Error;
  constructor(originalError: Error) {
    const message = originalError?.message;
    super(message ? `CrystalError: ${message}` : `CrystalError`);
    this.originalError = originalError;
  }
}

/**
 * DO NOT ALLOW CONSTRUCTION OF ERRORS OUTSIDE OF THIS MODULE!
 *
 * @internal
 */
export function newCrystalError(error: Error) {
  return new _CrystalError(error);
}

export function isCrystalError(value: any): value is CrystalError {
  return value != null && value.constructor === _CrystalError;
}
