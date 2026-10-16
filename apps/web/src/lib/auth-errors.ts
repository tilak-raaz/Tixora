/** The error Better Auth's client returns. Our rate limiter's 429 and 503 arrive the same way. */
export interface AuthClientError {
  status?: number;
  code?: string;
  message?: string;
}

/** A sentence to show under the sign-in or sign-up form. */
export function authErrorMessage(error: AuthClientError): string {
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  if (error.status === 503) return 'Signing in is unavailable right now. Try again shortly.';
  const code = error.code ?? '';
  if (code === 'INVALID_EMAIL_OR_PASSWORD' || error.status === 401) {
    return 'Wrong email or password.';
  }
  if (code.startsWith('USER_ALREADY_EXISTS')) {
    return 'An account with this email already exists. Sign in instead.';
  }
  if (code === 'PASSWORD_TOO_SHORT') return 'Use at least 8 characters for the password.';
  if (code === 'INVALID_EMAIL') return 'Enter a valid email address.';
  return error.message || 'Something went wrong. Try again.';
}
