/** Flat poster colours, all from the app's palette family and all readable with white type. */
export const POSTER_COLOURS = ['#c8102e', '#141416', '#1f4fb8', '#1d6b45', '#b45309', '#5b2a86'];

/**
 * A stable colour per title, so a movie looks the same on every page and visit. FNV-1a spreads
 * similar titles across the palette better than a simple multiply-and-add hash.
 */
export function posterColour(title: string): string {
  let hash = 0x811c9dc5;
  for (const char of title) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return POSTER_COLOURS[hash % POSTER_COLOURS.length] ?? '#141416';
}
