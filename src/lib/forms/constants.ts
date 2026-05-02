/**
 * Shared (non-server) constants for the form-style endpoints. Safe to
 * import from client components because the field-name string isn't
 * a secret — real spam bots already fill every input.
 */
export const HONEYPOT_FIELD = "_hp" as const;
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_MAX_PER_WINDOW = 3;
