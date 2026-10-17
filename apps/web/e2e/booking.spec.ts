import { expect, test } from '@playwright/test';
import { expireHold, openAShow, pickSeats, seat, signUp } from './helpers';

/** The whole journey in a browser, against the real API with fake payments. */

test('sign up, pick seats, pay and get the ticket', async ({ page }) => {
  await signUp(page);
  await openAShow(page);
  const labels = await pickSeats(page, 2);
  await expect(page.getByText(`2 seats: ${labels.join(', ')}`)).toBeVisible();

  await page.getByRole('button', { name: 'Hold seats' }).click();
  await expect(page).toHaveURL(/\/checkout\//);
  await expect(page.getByText('Held for you for')).toBeVisible();

  await page.getByRole('button', { name: /^Pay / }).click();
  const sheet = page.getByRole('dialog', { name: 'Test payment' });
  await sheet.getByRole('button', { name: /^Pay / }).click();

  // Confirmed by the webhook a moment later, never by the browser.
  await expect(page.getByText('Confirming your booking')).toBeVisible();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]+$/);
  await expect(page.getByText('Booking reference')).toBeVisible();
  await expect(page.getByText(labels.join(' '), { exact: true })).toBeVisible();

  const pdf = await page.request.get(
    (await page.getByRole('link', { name: 'Download ticket (PDF)' }).getAttribute('href'))!,
  );
  expect(pdf.headers()['content-type']).toBe('application/pdf');

  await page.getByRole('link', { name: 'My bookings' }).last().click();
  await expect(page.getByRole('heading', { name: 'Coming up' })).toBeVisible();
  await expect(page.getByText('Booked').first()).toBeVisible();
});

test("a hold in one browser shows up live in another's seat map", async ({ browser }) => {
  const watcherContext = await browser.newContext();
  const buyerContext = await browser.newContext();
  const watcher = await watcherContext.newPage();
  const buyer = await buyerContext.newPage();
  try {
    // Someone just looking, not signed in.
    const showPath = await openAShow(watcher);
    const [label] = await pickSeats(watcher, 1);
    await seat(watcher, label!).click(); // put it back; we only wanted a free seat's name

    // Someone else holds that seat.
    await signUp(buyer, showPath);
    await buyer.goto(showPath);
    await seat(buyer, label!).click();
    await buyer.getByRole('button', { name: 'Hold seats' }).click();
    await expect(buyer).toHaveURL(/\/checkout\//);

    // The watcher's map turns it taken without a reload.
    await expect(seat(watcher, label!)).toBeDisabled({ timeout: 3_000 });
    await expect(seat(watcher, label!)).toHaveAttribute('aria-label', /taken$/);

    // Releasing it frees it again, live.
    await buyer.getByRole('button', { name: 'Release seats' }).click();
    await expect(seat(watcher, label!)).toBeEnabled({ timeout: 3_000 });
  } finally {
    await watcherContext.close();
    await buyerContext.close();
  }
});

test('a failed payment keeps the hold so the buyer can try again', async ({ page }) => {
  await signUp(page);
  await openAShow(page);
  await pickSeats(page, 1);
  await page.getByRole('button', { name: 'Hold seats' }).click();
  await expect(page).toHaveURL(/\/checkout\//);

  await page.getByRole('button', { name: /^Pay / }).click();
  await page
    .getByRole('dialog', { name: 'Test payment' })
    .getByRole('button', { name: 'Fail payment' })
    .click();

  await expect(page.getByText('Payment failed')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Pay / })).toBeEnabled();
  await expect(page.getByText('Held for you for')).toBeVisible();
});

test('a hold that runs out says so and frees the seats', async ({ page }) => {
  await signUp(page);
  const showPath = await openAShow(page);
  const [label] = await pickSeats(page, 1);
  await page.getByRole('button', { name: 'Hold seats' }).click();
  await expect(page).toHaveURL(/\/checkout\//);
  const bookingId = new URL(page.url()).pathname.split('/').pop()!;

  // Five minutes later, as far as the database is concerned.
  await expireHold(bookingId);
  await page.reload();
  await expect(page.getByText('Your hold ended')).toBeVisible();

  await page.getByRole('link', { name: 'Pick seats again' }).click();
  await expect(page).toHaveURL(showPath);
  await expect(seat(page, label!)).toBeEnabled();
});

test('the account menu shows who is signed in and signs out', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: 'Account', exact: true }).click();

  const menu = page.getByRole('dialog', { name: 'Account', exact: true });
  await expect(menu.getByText('E2E Buyer')).toBeVisible();
  await expect(menu.getByRole('link', { name: /My bookings/ })).toBeVisible();

  await menu.getByRole('button', { name: 'Sign out' }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});
