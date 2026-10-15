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

## What to expect

- `POST /bookings/:id/payment-order` returns `201` the first time and the same order (`200`)
  after that. With under a minute of the hold left it refuses with `409 HOLD_ENDING_SOON`.
- After paying, the page checks Checkout's signature (`/payment/verify`) and polls the booking.
  It becomes `CONFIRMED` only when Razorpay's webhook arrives (next section): the browser is
  never trusted to confirm a payment. Without webhooks set up, it stays `PENDING_PAYMENT`.

## Webhooks to your laptop

Razorpay confirms payments by calling `POST /webhooks/razorpay`, so it has to reach
`localhost:4000`. A Cloudflare quick tunnel does that with no account:

```bash
brew install cloudflared                        # once
cloudflared tunnel --url http://localhost:4000  # prints https://<random>.trycloudflare.com
```

Then, in the Razorpay Dashboard (Test Mode) → **Account & Settings → Webhooks → Add New Webhook**:

- **Webhook URL:** `https://<random>.trycloudflare.com/webhooks/razorpay`
- **Secret:** generate one with `openssl rand -hex 32` and put the same value in `.env` as
  `RAZORPAY_WEBHOOK_SECRET`, then restart `make dev-api`
- **Active events:** `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`,
  `refund.failed`

The quick-tunnel URL changes every time `cloudflared` starts; update the webhook URL when it
does. The secret can stay.

Now pay on `/dev/checkout` as above: within a few seconds the page shows the booking
`CONFIRMED`, and `make dev-api` logs the webhook. To see the late-payment path, hold seats, wait
for the 5 minutes to pass with Checkout open, then pay: the booking stays `EXPIRED`, a
`HOLD_ENDED` refund is recorded, and with `make dev-worker` running it is sent to Razorpay within
seconds (`make psql`, then `SELECT reason, status, razorpay_refund_id FROM refunds;`). It shows
up under **Transactions → Refunds** in the Dashboard.

## Webhooks that never arrive

Stop `cloudflared` (or delete the webhook), pay on `/dev/checkout`, and watch the booking stay
`PENDING_PAYMENT`. Within about 3 minutes the worker's reconciler asks Razorpay about the order,
finds the captured payment and confirms the booking (or refunds it, if the hold had ended). The
worker logs `reconciler applied payments the webhook never delivered`.
