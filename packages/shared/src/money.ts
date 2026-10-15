const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

/**
 * Formats an amount in paise for display, Indian digit grouping included:
 * 55000 -> "₹550.00", 12345678 -> "₹1,23,456.78". Amounts are stored and
 * passed around as integer paise everywhere else (ADR 0003).
 */
export function formatPaise(paise: number): string {
  return inr.format(paise / 100);
}
