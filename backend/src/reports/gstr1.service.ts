import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../database/prisma.service.js';
import { Decimal } from '../common/decimal.js';
import { AppException } from '../common/errors/app-exception.js';
import { assertPermission, type AuthContext } from '../auth/auth-context.js';

export const gstr1Query = z.object({
  /** Filing month, e.g. 2026-11. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use YYYY-MM'),
  /** Which registration (a business with branches in several states has several). */
  gstin: z.string().trim().toUpperCase().optional(),
});
export type Gstr1Query = z.infer<typeof gstr1Query>;

const ZERO = new Decimal(0);
/** B2C invoices above this, to another state, are reported one by one (B2C Large, Table 5). */
export const B2CL_LIMIT = new Decimal(100000);
const r2 = (d: Decimal) => Number(d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
const ddmmyyyy = (d: Date) => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
const err = (code: string, message: string, status = HttpStatus.UNPROCESSABLE_ENTITY) => new AppException(code, message, status);

type Tax = { txval: Decimal; iamt: Decimal; camt: Decimal; samt: Decimal; csamt: Decimal };
const zeroTax = (): Tax => ({ txval: ZERO, iamt: ZERO, camt: ZERO, samt: ZERO, csamt: ZERO });
const addTax = (a: Tax, b: Tax, sign = 1): Tax => ({
  txval: a.txval.plus(b.txval.times(sign)),
  iamt: a.iamt.plus(b.iamt.times(sign)),
  camt: a.camt.plus(b.camt.times(sign)),
  samt: a.samt.plus(b.samt.times(sign)),
  csamt: a.csamt.plus(b.csamt.times(sign)),
});
const taxJson = (t: Tax, inter: boolean) =>
  inter ? { txval: r2(t.txval), iamt: r2(t.iamt), csamt: r2(t.csamt) } : { txval: r2(t.txval), camt: r2(t.camt), samt: r2(t.samt), csamt: r2(t.csamt) };

/** A returned line's tax, split the way the original invoice was (GST vs cess, CGST/SGST vs IGST). */
function returnTax(taxable: Decimal, tax: Decimal, gstRate: Decimal, cessRate: Decimal, inter: boolean): Tax {
  const rate = gstRate.plus(cessRate);
  const gst = rate.isZero() ? ZERO : tax.times(gstRate).dividedBy(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const cess = tax.minus(gst);
  if (inter) return { txval: taxable, iamt: gst, camt: ZERO, samt: ZERO, csamt: cess };
  const c = gst.dividedBy(2).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { txval: taxable, iamt: ZERO, camt: c, samt: gst.minus(c), csamt: cess };
}

/** Invoice series = the number without its running sequence: GST1/2627/00042 → GST1/2627/. */
const seriesOf = (no: string) => no.slice(0, no.lastIndexOf('/') + 1);
const seqOf = (no: string) => Number(no.slice(no.lastIndexOf('/') + 1).replace(/\D/g, '')) || 0;

/**
 * GSTR-1 for one registration and month, as the JSON the GST portal's offline tool imports
 * (B2B, B2C Large, B2C Small, credit notes, nil/exempt, HSN summary split B2B/B2C, documents
 * issued). Built from the invoices and credit notes exactly as issued. The filer still reviews
 * and files it on the portal; this does not file anything.
 */
@Injectable()
export class Gstr1Service {
  constructor(private readonly prisma: PrismaService) {}

  build(auth: AuthContext, q: Gstr1Query) {
    assertPermission(auth, 'reports:finance');
    if (auth.storeIds !== 'ALL')
      throw err('FORBIDDEN', 'GSTR-1 covers every branch of a registration — ask someone with access to all branches.', HttpStatus.FORBIDDEN);
    return this.prisma.withTenant(
      auth.tenantId,
      async (tx) => {
        const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: auth.tenantId } });
        if (tenant.registration !== 'REGULAR')
          throw err(
            'NOT_REGULAR',
            tenant.registration === 'COMPOSITION'
              ? 'A composition business files CMP-08 and GSTR-4, not GSTR-1.'
              : 'An unregistered business doesn’t file GSTR-1.',
            HttpStatus.CONFLICT
          );
        const allStores = await tx.store.findMany({ where: { tenantId: auth.tenantId } });
        const gstinOf = (s: { gstin: string | null }) => s.gstin ?? tenant.gstin;
        const registrations = [...new Set(allStores.map(gstinOf).filter((g): g is string => !!g))];
        const gstin = q.gstin ?? (registrations.length === 1 ? registrations[0] : undefined);
        if (!gstin)
          throw err('GSTIN_REQUIRED', `This business has ${registrations.length} GST registrations — choose one: ${registrations.join(', ')}.`, HttpStatus.BAD_REQUEST);
        if (!registrations.includes(gstin)) throw err('NOT_FOUND', 'That GSTIN is not one of this business’s registrations.', HttpStatus.NOT_FOUND);
        const stores = allStores.filter((s) => gstinOf(s) === gstin);
        const storeIds = stores.map((s) => s.id);
        const home = gstin.slice(0, 2);

        const [y, m] = q.month.split('-').map(Number) as [number, number];
        const from = new Date(Date.UTC(y, m - 1, 1));
        const to = new Date(Date.UTC(y, m, 0));
        const fp = `${String(m).padStart(2, '0')}${y}`;

        const units = new Map((await tx.unit.findMany({ where: { tenantId: auth.tenantId } })).map((u) => [u.code, u.uqc]));
        const sales = await tx.sale.findMany({
          where: { tenantId: auth.tenantId, storeId: { in: storeIds }, documentType: 'TAX_INVOICE', businessDate: { gte: from, lte: to } },
          include: { items: { include: { product: { select: { taxRate: { select: { kind: true } } } } } } },
          orderBy: [{ businessDate: 'asc' }, { invoiceNo: 'asc' }],
        });
        const returns = await tx.saleReturn.findMany({
          where: { tenantId: auth.tenantId, storeId: { in: storeIds }, businessDate: { gte: from, lte: to }, sale: { documentType: 'TAX_INVOICE' } },
          include: {
            sale: { select: { invoiceNo: true, businessDate: true, buyerGstin: true, placeOfSupply: true, interState: true, payable: true } },
            items: { include: { saleItem: { include: { product: { select: { taxRate: { select: { kind: true } } } } } } } },
          },
          orderBy: [{ businessDate: 'asc' }, { creditNoteNo: 'asc' }],
        });

        const warnings: string[] = [];
        const done = sales.filter((s) => s.status === 'COMPLETED');

        /* ---- invoices ---- */
        const b2b = new Map<string, unknown[]>();
        const b2cl = new Map<string, unknown[]>();
        const b2cs = new Map<string, { sply_ty: 'INTRA' | 'INTER'; pos: string; rt: number; t: Tax }>();
        const nil = new Map<string, { expt: Decimal; nil: Decimal; ngsup: Decimal }>();
        const hsn = { b2b: new Map<string, { hsn: string; uqc: string; rt: number; qty: Decimal; t: Tax; desc: string }>(), b2c: new Map<string, { hsn: string; uqc: string; rt: number; qty: Decimal; t: Tax; desc: string }>() };
        let missingHsn = 0;

        const nilKey = (inter: boolean, b2bSale: boolean) => `${inter ? 'INTR' : 'INTRA'}${b2bSale ? 'B2B' : 'B2C'}`;
        const addNil = (key: string, kind: string, amount: Decimal) => {
          const e = nil.get(key) ?? { expt: ZERO, nil: ZERO, ngsup: ZERO };
          if (kind === 'EXEMPT') e.expt = e.expt.plus(amount);
          else if (kind === 'NON_GST') e.ngsup = e.ngsup.plus(amount);
          else e.nil = e.nil.plus(amount);
          nil.set(key, e);
        };
        const addHsn = (b2bSale: boolean, code: string | null, unit: string, rate: number, qty: Decimal, t: Tax, desc: string, sign = 1) => {
          if (!code) {
            missingHsn++;
            return;
          }
          const uqc = units.get(unit) ?? 'OTH';
          const k = `${code}|${uqc}|${rate}`;
          const map = b2bSale ? hsn.b2b : hsn.b2c;
          const e = map.get(k) ?? { hsn: code, uqc, rt: rate, qty: ZERO, t: zeroTax(), desc };
          e.qty = e.qty.plus(qty.times(sign));
          e.t = addTax(e.t, t, sign);
          map.set(k, e);
        };

        for (const s of done) {
          const isB2b = !!s.buyerGstin;
          const byRate = new Map<number, Tax>();
          for (const i of s.items) {
            const t: Tax = { txval: i.taxable, iamt: i.igst, camt: i.cgst, samt: i.sgst, csamt: i.cess };
            const rate = Number(i.gstRate);
            addHsn(isB2b, i.hsnCode, i.unitCode, rate, i.qty, t, i.name);
            if (rate === 0) {
              addNil(nilKey(s.interState, isB2b), i.product.taxRate.kind, i.taxable);
              continue;
            }
            byRate.set(rate, addTax(byRate.get(rate) ?? zeroTax(), t));
          }
          if (!byRate.size) continue; // only nil/exempt lines: reported in Table 8 alone
          const itms = [...byRate.entries()].map(([rt, t], k) => ({ num: k + 1, itm_det: { rt, ...taxJson(t, s.interState) } }));
          if (isB2b) {
            const list = b2b.get(s.buyerGstin!) ?? [];
            list.push({ inum: s.invoiceNo, idt: ddmmyyyy(s.businessDate), val: r2(s.payable), pos: s.placeOfSupply, rchrg: 'N', inv_typ: 'R', itms });
            b2b.set(s.buyerGstin!, list);
          } else if (s.interState && s.payable.gt(B2CL_LIMIT)) {
            const list = b2cl.get(s.placeOfSupply) ?? [];
            list.push({ inum: s.invoiceNo, idt: ddmmyyyy(s.businessDate), val: r2(s.payable), itms });
            b2cl.set(s.placeOfSupply, list);
          } else {
            for (const [rt, t] of byRate) {
              const k = `${s.interState ? 'INTER' : 'INTRA'}|${s.placeOfSupply}|${rt}`;
              const e = b2cs.get(k) ?? { sply_ty: s.interState ? 'INTER' : 'INTRA', pos: s.placeOfSupply, rt, t: zeroTax() };
              e.t = addTax(e.t, t);
              b2cs.set(k, e);
            }
          }
        }

        /* ---- credit notes ---- */
        const cdnr = new Map<string, unknown[]>();
        const cdnur: unknown[] = [];
        for (const r of returns) {
          const s = r.sale;
          const isB2b = !!s.buyerGstin;
          const byRate = new Map<number, Tax>();
          for (const ri of r.items) {
            const si = ri.saleItem;
            const rate = Number(si.gstRate);
            const t = returnTax(ri.taxable, ri.tax, si.gstRate, si.cessRate, s.interState);
            addHsn(isB2b, si.hsnCode, si.unitCode, rate, ri.qty, t, si.name, -1);
            if (rate === 0) {
              addNil(nilKey(s.interState, isB2b), si.product.taxRate.kind, ri.taxable.negated());
              continue;
            }
            byRate.set(rate, addTax(byRate.get(rate) ?? zeroTax(), t));
          }
          if (!byRate.size) continue;
          const itms = [...byRate.entries()].map(([rt, t], k) => ({ num: k + 1, itm_det: { rt, ...taxJson(t, s.interState) } }));
          const note = { ntty: 'C', nt_num: r.creditNoteNo, nt_dt: ddmmyyyy(r.businessDate), val: r2(r.total), pos: s.placeOfSupply };
          if (isB2b) {
            const list = cdnr.get(s.buyerGstin!) ?? [];
            list.push({ ...note, rchrg: 'N', inv_typ: 'R', itms });
            cdnr.set(s.buyerGstin!, list);
          } else if (s.interState && s.payable.gt(B2CL_LIMIT)) {
            cdnur.push({ ...note, typ: 'B2CL', itms });
          } else {
            // Small B2C: credit notes are netted off the B2C Small totals of the month.
            for (const [rt, t] of byRate) {
              const k = `${s.interState ? 'INTER' : 'INTRA'}|${s.placeOfSupply}|${rt}`;
              const e = b2cs.get(k) ?? { sply_ty: s.interState ? 'INTER' : 'INTRA', pos: s.placeOfSupply, rt, t: zeroTax() };
              e.t = addTax(e.t, t, -1);
              b2cs.set(k, e);
            }
          }
        }

        /* ---- documents issued (Table 13) ---- */
        const docs = (kind: number, nos: { no: string; cancelled: boolean }[]) => {
          const by = new Map<string, { no: string; cancelled: boolean }[]>();
          for (const d of nos) by.set(seriesOf(d.no), [...(by.get(seriesOf(d.no)) ?? []), d]);
          const list = [...by.values()].map((g, k) => {
            const sorted = [...g].sort((a, b) => seqOf(a.no) - seqOf(b.no));
            const cancel = g.filter((d) => d.cancelled).length;
            return { num: k + 1, from: sorted[0]!.no, to: sorted[sorted.length - 1]!.no, totnum: g.length, cancel, net_issue: g.length - cancel };
          });
          return list.length ? [{ doc_num: kind, docs: list }] : [];
        };
        const doc_det = [
          ...docs(1, sales.map((s) => ({ no: s.invoiceNo, cancelled: s.status === 'VOIDED' }))),
          ...docs(5, returns.map((r) => ({ no: r.creditNoteNo, cancelled: false }))),
        ];

        /* ---- assemble ---- */
        const b2csRows = [...b2cs.values()].filter((e) => !e.t.txval.isZero() || !e.t.iamt.isZero() || !e.t.camt.isZero());
        if (b2csRows.some((e) => e.t.txval.isNegative()))
          warnings.push('Credit notes this month are larger than the B2C Small sales they belong to at some rate — the portal may reject a negative B2CS row; adjust it in the offline tool.');
        if (missingHsn) warnings.push(`${missingHsn} line${missingHsn === 1 ? '' : 's'} had no HSN code and are left out of the HSN summary (Table 12). Add HSN codes on the Products page.`);
        const hsnJson = (map: typeof hsn.b2b) =>
          [...map.values()]
            .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rt - b.rt)
            .map((e, k) => ({ num: k + 1, hsn_sc: e.hsn, desc: e.desc.slice(0, 30), uqc: e.uqc, qty: Number(e.qty.toFixed(3)), rt: e.rt, txval: r2(e.t.txval), iamt: r2(e.t.iamt), camt: r2(e.t.camt), samt: r2(e.t.samt), csamt: r2(e.t.csamt) }));

        const file = {
          gstin,
          fp,
          version: 'GST3.2',
          hash: 'hash',
          ...(b2b.size && { b2b: [...b2b.entries()].map(([ctin, inv]) => ({ ctin, inv })) }),
          ...(b2cl.size && { b2cl: [...b2cl.entries()].map(([pos, inv]) => ({ pos, inv })) }),
          ...(b2csRows.length && {
            b2cs: b2csRows.map((e) => ({ sply_ty: e.sply_ty, pos: e.pos, typ: 'OE', rt: e.rt, ...taxJson(e.t, e.sply_ty === 'INTER') })),
          }),
          ...(cdnr.size && { cdnr: [...cdnr.entries()].map(([ctin, nt]) => ({ ctin, nt })) }),
          ...(cdnur.length && { cdnur }),
          ...(nil.size && {
            nil: { inv: [...nil.entries()].map(([sply_ty, e]) => ({ sply_ty, expt_amt: r2(e.expt), nil_amt: r2(e.nil), ngsup_amt: r2(e.ngsup) })) },
          }),
          ...((hsn.b2b.size || hsn.b2c.size) && { hsn: { hsn_b2b: hsnJson(hsn.b2b), hsn_b2c: hsnJson(hsn.b2c) } }),
          ...(doc_det.length && { doc_issue: { doc_det } }),
        };

        const sum = (rows: Tax[]) => rows.reduce((a, b) => addTax(a, b), zeroTax());
        const tot = (t: Tax) => ({ taxable: r2(t.txval), tax: r2(t.iamt.plus(t.camt).plus(t.samt).plus(t.csamt)) });
        const invTax = (list: unknown[]) =>
          sum((list as { itms: { itm_det: { txval: number; iamt?: number; camt?: number; samt?: number; csamt: number } }[] }[]).flatMap((i) => i.itms.map((x) => ({ txval: new Decimal(x.itm_det.txval), iamt: new Decimal(x.itm_det.iamt ?? 0), camt: new Decimal(x.itm_det.camt ?? 0), samt: new Decimal(x.itm_det.samt ?? 0), csamt: new Decimal(x.itm_det.csamt) }))));
        const b2bList = [...b2b.values()].flat();
        const b2clList = [...b2cl.values()].flat();
        const cdnrList = [...cdnr.values()].flat();
        return {
          gstin,
          period: q.month,
          fp,
          registrations,
          branches: stores.map((s) => ({ id: s.id, name: s.name })),
          summary: {
            b2b: { invoices: b2bList.length, recipients: b2b.size, ...tot(invTax(b2bList)) },
            b2cl: { invoices: b2clList.length, ...tot(invTax(b2clList)) },
            b2cs: { rows: b2csRows.length, ...tot(sum(b2csRows.map((e) => e.t))) },
            cdnr: { notes: cdnrList.length, ...tot(invTax(cdnrList)) },
            cdnur: { notes: cdnur.length, ...tot(invTax(cdnur)) },
            nil: {
              exempt: r2([...nil.values()].reduce((a, e) => a.plus(e.expt), ZERO)),
              nilRated: r2([...nil.values()].reduce((a, e) => a.plus(e.nil), ZERO)),
              nonGst: r2([...nil.values()].reduce((a, e) => a.plus(e.ngsup), ZERO)),
            },
            hsn: { b2bRows: hsn.b2b.size, b2cRows: hsn.b2c.size },
            documents: { invoices: sales.length, cancelled: sales.filter((s) => s.status === 'VOIDED').length, creditNotes: returns.length },
          },
          warnings,
          note: 'Built from your invoices and credit notes as issued. Import it into the GST offline tool or the portal’s “Upload JSON”, review every table, and file from the portal. Nothing is filed from here.',
          file,
        };
      },
      { timeout: 60_000 }
    );
  }
}

