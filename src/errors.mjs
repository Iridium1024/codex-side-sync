export class SideError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

export function fail(code, details) { throw new SideError(code, details); }
export function errorResult(error) {
  // Never return raw IPC payloads, stack traces, paths, or exception messages.
  return { status: error instanceof SideError ? error.code : 'internal_error',
    ...(error instanceof SideError ? { details: error.details } : {}) };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function identity(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_arguments', { field });
  return value.toLowerCase();
}
