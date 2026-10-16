import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import pg from 'pg';
import { DATABASE_URL } from './env';

/** Signs a new user up through the form and waits for the header to show them. */
export async function signUp(page: Page, next = '/'): Promise<void> {
  await page.goto(`/signup?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Name').fill('E2E Buyer');
  await page.getByLabel('Email').fill(`e2e-${randomUUID()}@example.test`);
  await page.getByLabel('Password').fill(`pw-${randomUUID()}`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}

/**
 * Opens a show's seat map the way a buyer would: tomorrow on the home page (so every show is
 * still ahead), the first movie, its first show. Returns the show page's path.
 */
export async function openAShow(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Pick a date' }).getByRole('link').nth(1).click();
  await expect(page).toHaveURL(/date=/);
  await page.locator('a[href^="/movies/"]').first().click();
  await expect(page).toHaveURL(/\/movies\//);
  await page.locator('a[href^="/shows/"]').first().click();
  await expect(page.getByRole('heading', { name: 'Pick your seats' })).toBeVisible();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return new URL(page.url()).pathname;
}

/** The free seats on the open seat map, as buttons. */
export function freeSeats(page: Page) {
  return page.locator('button[aria-pressed="false"]:not([disabled])');
}

/** Picks `count` free seats and returns their labels ("E6"). */
export async function pickSeats(page: Page, count: number): Promise<string[]> {
  const labels: string[] = [];
  for (let i = 0; i < count; i++) {
    const seat = freeSeats(page).first();
    const label = (await seat.getAttribute('aria-label'))!.split(',')[0]!;
    await seat.click();
    labels.push(label);
  }
  return labels;
}

/** The seat button for a label such as "E6". */
export function seat(page: Page, label: string) {
  return page.locator(`button[aria-label^="${label},"]`);
}

/** Moves a hold 10 minutes into the past, as if the buyer had walked away. */
export async function expireHold(bookingId: string): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `UPDATE bookings SET created_at = now() - interval '10 minutes',
                           expires_at = now() - interval '1 minute' WHERE id = $1`,
      [bookingId],
    );
    await client.query(
      `UPDATE show_seats SET held_until = now() - interval '1 minute' WHERE booking_id = $1`,
      [bookingId],
    );
  } finally {
    await client.end();
  }
}
