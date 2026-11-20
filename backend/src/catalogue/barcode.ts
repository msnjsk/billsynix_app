/** GS1 check digit for the digits before it (EAN-8, UPC-A, EAN-13, GTIN-14). */
export function gtinCheckDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return String((10 - (sum % 10)) % 10);
}

const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/** Normalised form a barcode is stored and looked up in. */
export const normaliseCode = (code: string) => code.trim().toUpperCase();

/**
 * null when the code is acceptable. All-digit codes of a GS1 length must carry a correct check
 * digit — that catches mistyped barcodes; other codes (in-house labels) are free-form.
 */
export function barcodeProblem(code: string): string | null {
  if (!/^[0-9A-Z][0-9A-Z.\-/]{2,31}$/.test(code))
    return 'A barcode is 3–32 letters or digits (also . - /).';
  if (
    /^\d+$/.test(code) &&
    GTIN_LENGTHS.has(code.length) &&
    gtinCheckDigit(code.slice(0, -1)) !== code.at(-1)
  )
    return `The check digit of ${code} is wrong — is it typed correctly?`;
  return null;
}

/** SKU: upper-case letters, digits and - _ . / — 1 to 40 characters. */
export const SKU_PATTERN = /^[0-9A-Z][0-9A-Z\-_./]{0,39}$/;
