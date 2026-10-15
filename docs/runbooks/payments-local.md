# Paying in Razorpay test mode, locally

Until the frontend exists (M6), `/dev/checkout` is the way to hold seats and pay by hand. It
calls the real API exactly as a browser app would. Test mode moves no real money.

## One-time setup

1. In the Razorpay Dashboard, switch to **Test Mode** (toggle at the top).
2. **Account & Settings → API Keys → Generate Test Key.** Copy the key id (`rzp_test_...`) and
   the key secret (shown once).
3. Put them in `.env` (git-ignored), never anywhere else:

   ```bash
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   ```

Without these the API still starts; the payment endpoints answer `503 SERVICE_UNAVAILABLE`.

## Paying

```bash
make up
make migrate
make seed        # once: a demo city, theatres and a week of shows
make dev-api
make dev-worker  # second terminal: hold expiry
```

Open <http://localhost:4000/dev/checkout> and go top to bottom:

1. **Sign up** (or sign in) with any email and password.
2. Pick a city and date, **Find shows**, choose one, **Seat map**.
3. Click up to 5 seats, **Hold picked seats**. The hold lasts 5 minutes.
4. **Pay with Razorpay** opens Checkout. Use a test method from Razorpay's
   [test card and UPI details](https://razorpay.com/docs/payments/payments/test-card-details/),
   for example UPI id `success@razorpay`.

The log at the bottom shows every request and response.

## What to expect at this stage

- `POST /bookings/:id/payment-order` returns `201` the first time and the same order (`200`)
  after that. With under a minute of the hold left it refuses with `409 HOLD_ENDING_SOON`.
- After paying, the page checks Checkout's signature (`/payment/verify`) and polls the booking.
  **It stays `PENDING_PAYMENT`** until the webhook lands in M3 PR 3: the browser is never
  trusted to confirm a payment.
- If the hold expires first, the booking becomes `EXPIRED`. From PR 3 such a late payment is
  refunded automatically.
