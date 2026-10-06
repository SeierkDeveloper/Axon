// Agent Minds: numbers as people read them.

/**
 * A number as text, to a few significant digits and never with an exponent: a very small amount of ETH reads
 * "0.000000391", not "3.91e-7". Used wherever a figure is put into words for a mind or for a page.
 */
export function plain(v: number, digits = 4): string {
  const n = +v.toPrecision(digits);
  if (n === 0) return "0";
  const s = String(n);
  return /e/i.test(s) ? n.toFixed(Math.min(20, digits - 1 - Math.floor(Math.log10(Math.abs(n))))).replace(/\.?0+$/, "") : s;
}
