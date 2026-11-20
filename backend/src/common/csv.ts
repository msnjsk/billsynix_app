/**
 * Minimal RFC 4180 CSV reader/writer for catalogue import and export. Handles quoted fields,
 * doubled quotes, CRLF/LF/CR line ends and a UTF-8 byte-order mark.
 */

export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
  }
}

/** Rows of cells. Blank lines are dropped. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let quoteLine = 1;

  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (cell !== '')
        throw new CsvError('A quote may only start a field.', line);
      quoted = true;
      quoteLine = line;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
    } else {
      cell += ch;
    }
  }
  if (quoted) throw new CsvError('A quoted field is not closed.', quoteLine);
  if (cell !== '' || row.length) endRow();
  return rows;
}

/** Cells a spreadsheet would run as a formula ("=", "+", "-", "@", tab, CR). */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutralises formula injection: a cell that would start a formula gets a leading apostrophe,
 * which spreadsheets hide. `unguardCell` reverses it on import so export → import round-trips.
 */
export const guardCell = (v: string) => (FORMULA_START.test(v) ? `'${v}` : v);
export const unguardCell = (v: string) =>
  v.startsWith("'") && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v;

const quote = (v: string) =>
  /[",\r\n]|^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** CSV text with CRLF line ends and a BOM so Excel opens UTF-8 (e.g. Tamil names) correctly. */
export function toCsv(
  rows: ReadonlyArray<
    ReadonlyArray<string | number | boolean | null | undefined>
  >,
): string {
  const body = rows
    .map((r) =>
      r
        .map((v) => (v === null || v === undefined ? '' : String(v)))
        .map((v) => quote(guardCell(v)))
        .join(','),
    )
    .join('\r\n');
  return `﻿${body}\r\n`;
}
