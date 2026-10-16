# Paying locally: fake payments or Razorpay test mode

There are two ways to pay in the web app (`make dev-web`, <http://localhost:3000>):

- **Fake payments** (`PAYMENT_GATEWAY=fake`): no Razorpay account, no tunnel. Good for
  everyday development and the end-to-end tests.
- **Razorpay test mode**: the real Checkout and real webhooks, with test money.

## Fake payments

Set `PAYMENT_GATEWAY=fake` in `.env` and restart `make dev-api` (it logs a warning that payments
are simulated). Hold seats, then **Pay** opens a "Test payment" sheet with **Pay** and **Fail
payment**:

- **Pay** answers like Razorpay Checkout (order id, payment id, signature), and about 1.5 s later
  the API sends itself a signed `payment.captured` webhook through the real webhook handler. The
  page shows "Confirming your booking" until that webhook confirms it, then the ticket.
- **Fail payment** sends `payment.failed`; the hold stays open, so you can try again.

Fake orders live in the API's memory, so they are gone after a restart, and the worker does not
send refunds for them. `PAYMENT_GATEWAY=fake` is refused when `NODE_ENV=production`.

## Razorpay test mode

### One-time setup

1. In the Razorpay Dashboard, switch to **Test Mode** (toggle at the top).
2. **Account & Settings → API Keys → Generate Test Key.** Copy the key id (`rzp_test_...`) and
   the key secret (shown once).
3. Put them in `.env` (git-ignored), never anywhere else:

   ```bash
   RAZORPAY_KEY_ID=rzp_test_...
   RAZORPAY_KEY_SECRET=...
   ```

Without these the API still starts; the payment endpoints answer `503 SERVICE_UNAVAILABLE`.

### Paying

Leave `PAYMENT_GATEWAY` empty (or `razorpay`), then:

```bash
make up
make migrate
make seed        # once: a demo city, theatres and a week of shows
make dev-api
make dev-worker  # second terminal: hold expiry
```

Open <http://localhost:3000>, pick a show and seats, **Hold seats**, then **Pay**: Razorpay
Checkout opens. Use a test method from Razorpay's
[test card and UPI details](https://razorpay.com/docs/payments/payments/test-card-details/),
for example UPI id `success@razorpay`.

### What to expect

- `POST /bookings/:id/payment-order` returns `201` the first time and the same order (`200`)
  after that. With under a minute of the hold left it refuses with `409 HOLD_ENDING_SOON`.
- After paying, the page checks Checkout's signature (`/payment/verify`), then waits up to 30 s
  for the booking to change.
  It becomes `CONFIRMED` only when Razorpay's webhook arrives (next section): the browser is
  never trusted to confirm a payment. Without webhooks set up, it stays `PENDING_PAYMENT`.

### Webhooks to your laptop

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

Now pay as above: within a few seconds the page shows your ticket, and `make dev-api` logs the webhook. To see the late-payment path, hold seats, wait
for the 5 minutes to pass with Checkout open, then pay: the booking stays `EXPIRED`, a
`HOLD_ENDED` refund is recorded, and with `make dev-worker` running it is sent to Razorpay within
seconds (`make psql`, then `SELECT reason, status, razorpay_refund_id FROM refunds;`). It shows
up under **Transactions → Refunds** in the Dashboard.

## Emails

With `make dev-worker` running, every confirmation and refund notice lands in Mailpit at
<http://localhost:8025> (started by `make up`). Nothing is sent to a real address in development.

## Webhooks that never arrive

Stop `cloudflared` (or delete the webhook), pay in Razorpay test mode, and watch the booking stay
`PENDING_PAYMENT`. Within about 3 minutes the worker's reconciler asks Razorpay about the order,
finds the captured payment and confirms the booking (or refunds it, if the hold had ended). The
worker logs `reconciler applied payments the webhook never delivered`.
