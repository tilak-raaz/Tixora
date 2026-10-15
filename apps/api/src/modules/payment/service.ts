import type { Logger, Pool } from '@bmt/platform';
import { GatewayError, type GatewayOrder, type PaymentGateway } from '@bmt/payments';
import { AppError, NotFoundError } from '../../lib/errors';
import { findBookingView, type BookingView } from '../booking/repo';
import * as repo from './repo';
import type { VerifyCheckoutInput } from './schemas';

export interface PaymentConfig {
  /** No new order for a hold with less time left than this; the buyer picks seats again. */
  minSecondsLeft: number;
}

export const DEFAULT_PAYMENT_CONFIG: PaymentConfig = { minSecondsLeft: 60 };

/** Everything the browser needs to open Razorpay Checkout. */
export interface PaymentOrderView {
  bookingId: string;
  razorpayOrderId: string;
  amountPaise: number;
  currency: string;
  keyId: string;
  expiresAt: Date;
}

export type PaymentService = ReturnType<typeof createPaymentService>;

export function createPaymentService(
  pool: Pool,
  gateway: PaymentGateway,
  logger: Logger,
  config: PaymentConfig = DEFAULT_PAYMENT_CONFIG,
) {
  async function activeHold(userId: string, bookingId: string): Promise<repo.PayableBooking> {
    const booking = await repo.findBookingForPayment(pool, bookingId, userId);
    // Someone else's booking is "not found", as everywhere else.
    if (!booking) throw new NotFoundError('Booking not found');
    if (booking.status !== 'PENDING_PAYMENT' || booking.secondsLeft <= 0) {
      throw new AppError(409, 'HOLD_NOT_ACTIVE', 'This booking is no longer waiting for payment');
    }
    return booking;
  }

  function toView(order: repo.OrderRow, booking: repo.PayableBooking): PaymentOrderView {
    return {
      bookingId: booking.id,
      razorpayOrderId: order.razorpayOrderId,
      amountPaise: order.amountPaise,
      currency: order.currency,
      keyId: gateway.keyId,
      expiresAt: booking.expiresAt,
    };
  }

  /** Turns a Razorpay failure into a 502 the client can retry; nothing is stored. */
  async function viaGateway<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof GatewayError)) throw err;
      logger.warn({ err, status: err.status, code: err.code }, `razorpay ${what} failed`);
      throw new AppError(
        502,
        'PAYMENT_GATEWAY_ERROR',
        'The payment provider did not answer; try again',
      );
    }
  }

  /**
   * Finds the Razorpay order for this booking, creating it if none exists.
   * The booking id is the receipt, so a retry after a crash (order created at
   * Razorpay, never stored here) finds that order instead of making another.
   */
  async function findOrCreateAtRazorpay(booking: repo.PayableBooking): Promise<GatewayOrder> {
    const existing = await viaGateway('order lookup', () => gateway.findOrderByReceipt(booking.id));
    if (existing) return existing;
    try {
      return await gateway.createOrder({
        amountPaise: booking.totalPaise,
        receipt: booking.id,
        notes: { booking_id: booking.id },
      });
    } catch (err) {
      // Razorpay may refuse a second order with the same receipt: a concurrent
      // request got there first, so use its order.
      if (err instanceof GatewayError && err.status === 400) {
        const raced = await viaGateway('order lookup', () =>
          gateway.findOrderByReceipt(booking.id),
        );
        if (raced) return raced;
      }
      return viaGateway('order creation', () => Promise.reject(err));
    }
  }

  return {
    /**
     * Returns the booking's Razorpay order, creating it on the first call.
     * No transaction is open while Razorpay is called (no external call ever
     * holds a connection or a row lock); the database's one-order-per-booking
     * rule settles a race between two requests afterwards.
     */
    async createOrder(
      userId: string,
      bookingId: string,
    ): Promise<{ order: PaymentOrderView; created: boolean }> {
      const booking = await activeHold(userId, bookingId);
      const stored = await repo.findOrder(pool, booking.id);
      if (stored) return { order: toView(stored, booking), created: false };

      if (booking.secondsLeft < config.minSecondsLeft) {
        throw new AppError(
          409,
          'HOLD_ENDING_SOON',
          `Less than ${config.minSecondsLeft} seconds of this hold are left; choose your seats again`,
        );
      }

      const order = await findOrCreateAtRazorpay(booking);
      if (order.amountPaise !== booking.totalPaise || order.currency !== 'INR') {
        // Only possible if a receipt were reused for a different amount; never pay it.
        logger.error(
          { bookingId, razorpayOrderId: order.id },
          'razorpay order does not match booking',
        );
        throw new AppError(
          502,
          'PAYMENT_GATEWAY_ERROR',
          'The payment order did not match the booking',
        );
      }

      const created = await repo.insertOrder(pool, {
        bookingId: booking.id,
        razorpayOrderId: order.id,
        amountPaise: order.amountPaise,
      });
      // Ours, or the one a concurrent request stored first (ours is then never shown to anyone).
      const winner = (await repo.findOrder(pool, booking.id))!;
      if (!created && winner.razorpayOrderId !== order.id) {
        logger.info(
          { bookingId, orphan: order.id },
          'concurrent request stored another order first',
        );
      }
      return { order: toView(winner, booking), created };
    },

    /**
     * Checks the signature Checkout gave the browser. This only proves the
     * browser saw a real payment of this booking's order; the booking is
     * confirmed by the webhook, never here.
     */
    async verifyCheckout(
      userId: string,
      bookingId: string,
      input: VerifyCheckoutInput,
    ): Promise<{ verified: true; booking: BookingView }> {
      const booking = await findBookingView(pool, bookingId, userId);
      if (!booking) throw new NotFoundError('Booking not found');
      const order = await repo.findOrder(pool, bookingId);
      if (!order || order.razorpayOrderId !== input.razorpayOrderId) {
        throw new AppError(400, 'VALIDATION_FAILED', 'This payment order is not for this booking');
      }
      const valid = gateway.verifyCheckoutSignature({
        orderId: input.razorpayOrderId,
        paymentId: input.razorpayPaymentId,
        signature: input.razorpaySignature,
      });
      if (!valid) {
        throw new AppError(400, 'PAYMENT_SIGNATURE_INVALID', 'The payment signature is not valid');
      }
      return { verified: true, booking };
    },
  };
}
