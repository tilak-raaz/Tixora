import type { Pool } from '@bmt/platform';
import type { Auth } from './auth';

export interface AdminAccount {
  email: string;
  password: string;
  name: string;
}

/**
 * Creates the admin account if it does not exist, then makes sure it has the
 * admin role. Safe to run any number of times. There is no public way to become
 * an admin: only this function (via `make create-admin`) grants the role.
 *
 * Sessions cache the user in Redis, so a user promoted while signed in must sign
 * in again before the new role takes effect.
 */
export async function ensureAdmin(
  auth: Auth,
  pool: Pool,
  account: AdminAccount,
): Promise<{ userId: string; created: boolean }> {
  const existing = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [account.email],
  );
  const created = existing.rows.length === 0;

  if (created) {
    // Goes through Better Auth so the password is hashed and the account row is
    // created exactly as a normal sign-up would.
    await auth.api.signUpEmail({
      body: { email: account.email, password: account.password, name: account.name },
    });
  }

  const { rows } = await pool.query<{ id: string }>(
    "UPDATE users SET role = 'admin' WHERE lower(email) = lower($1) RETURNING id",
    [account.email],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`Admin account ${account.email} was not found after sign-up`);
  }
  return { userId: row.id, created };
}
