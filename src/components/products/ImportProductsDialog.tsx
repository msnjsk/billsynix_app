'use client';

import { useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, FileSpreadsheet, FileUp, TriangleAlert } from 'lucide-react';
import { api, errorMessage } from '@/lib/api/client';
import { reload } from '@/lib/live/hydrate';
import { Btn, ErrorLine, Modal } from '@/components/live/kit';

type ImportResult = {
  dryRun: boolean;
  committed: boolean;
  rows: number;
  created: number;
  updated: number;
  categoriesCreated: string[];
  brandsCreated: string[];
  errorCount: number;
  errors: { row: number; column?: string; message: string }[];
};

const COLUMNS: [string, string][] = [
  ['sku', 'Required. Your product code — rows are matched on it, so a second import updates.'],
  ['name', 'Required for new products.'],
  ['category', 'e.g. “Grocery > Flour”. Missing ones are created.'],
  ['unit', 'PCS, KG, LTR… (as on the Products form).'],
  ['tax', 'Required for new products: a rate (5, 18) or a tax name (“GST 5%”).'],
  ['hsn', '4, 6 or 8 digits.'],
  ['mrp / selling_price', 'Rupees. Selling price can’t be above MRP.'],
  ['barcodes', 'One or more, separated by “|”. Add “*6” for a pack of 6, e.g. 8901234100011|8901234100028*6'],
];

function saveText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * Bulk add or update products from a CSV (connected mode). The file is checked first; nothing is
 * written unless every row is fine, so a mistake never leaves half a catalogue behind.
 */
export function ImportProductsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<ImportResult | null>(null);
  const [done, setDone] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<'check' | 'import' | 'template' | 'export' | null>(null);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);

  const send = async (f: File, dryRun: boolean) => {
    const form = new FormData();
    form.append('file', f);
    return api<ImportResult>('POST', '/products/import', { form, query: { dryRun: dryRun ? 'true' : 'false' } });
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setCheck(null);
    setDone(null);
    setError('');
    if (!/\.csv$/i.test(f.name)) {
      setError('Choose a .csv file. In Excel: File › Save As › CSV UTF-8.');
      return;
    }
    setBusy('check');
    try {
      setCheck(await send(f, true));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!file) return;
    setBusy('import');
    setError('');
    try {
      const r = await send(file, false);
      if (r.committed) {
        setDone(r);
        await reload();
      } else setCheck(r);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const download = async (kind: 'template' | 'export') => {
    setBusy(kind);
    setError('');
    try {
      const text = await api<string>('GET', kind === 'template' ? '/products/import/template' : '/products/export', { text: true });
      saveText(kind === 'template' ? 'products-template.csv' : 'products.csv', text);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const reset = () => {
    setFile(null);
    setCheck(null);
    setDone(null);
    setError('');
    if (input.current) input.current.value = '';
  };

  return (
    <Modal open={open} onClose={onClose} wide title="Import products" sub="Add or update many products at once from a spreadsheet saved as CSV.">
      {done ? (
        <div className="space-y-4 py-4 text-center text-sm">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-teal/15 text-teal">
            <CheckCircle2 className="size-7" />
          </span>
          <div>
            <h3 className="text-lg font-extrabold">Import complete</h3>
            <p className="mt-1 text-sub">
              {done.created} product{done.created === 1 ? '' : 's'} added · {done.updated} updated
              {done.categoriesCreated.length > 0 && ` · ${done.categoriesCreated.length} new categor${done.categoriesCreated.length === 1 ? 'y' : 'ies'}`}
              {done.brandsCreated.length > 0 && ` · ${done.brandsCreated.length} new brand${done.brandsCreated.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <p className="text-xs text-mute">Stock isn’t part of the import — add opening stock on the Inventory page or receive it from a supplier.</p>
          <div className="flex justify-center gap-2">
            <Btn onClick={reset}>Import another file</Btn>
            <Btn tone="primary" onClick={onClose}>
              Done
            </Btn>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <ol className="grid gap-3 md:grid-cols-3">
            <Step n={1} title="Get the file">
              <div className="mt-2 flex flex-wrap gap-2">
                <Btn size="sm" busy={busy === 'template'} onClick={() => void download('template')}>
                  <FileSpreadsheet className="size-3.5" /> Blank template
                </Btn>
                <Btn size="sm" tone="quiet" busy={busy === 'export'} onClick={() => void download('export')}>
                  Current products
                </Btn>
              </div>
            </Step>
            <Step n={2} title="Fill it in">
              <p className="mt-1 text-xs text-sub">One product per row, in Excel or Google Sheets. Save as CSV (UTF-8).</p>
            </Step>
            <Step n={3} title="Upload and check">
              <p className="mt-1 text-xs text-sub">Every row is checked first. Nothing is saved until the whole file is right.</p>
            </Step>
          </ol>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void pick(e.dataTransfer.files[0]);
            }}
            className={`grid place-items-center rounded-2xl border-2 border-dashed px-4 py-8 text-center transition ${drag ? 'border-blue bg-blue/5' : 'border-line'}`}
          >
            <FileUp className="size-7 text-blue" />
            <p className="mt-2 font-semibold">{file ? file.name : 'Drop your CSV here'}</p>
            <p className="text-xs text-mute">Up to 5,000 products / 2 MB</p>
            <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
            <Btn size="sm" className="mt-3" busy={busy === 'check'} onClick={() => input.current?.click()}>
              {file ? 'Choose another file' : 'Choose file'}
            </Btn>
          </div>

          <ErrorLine>{error}</ErrorLine>

          {check &&
            (check.errorCount === 0 ? (
              <div className="flex items-start gap-3 rounded-xl bg-teal/10 p-3 text-teal">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0" />
                <div>
                  <b>The file looks good.</b> {check.rows} row{check.rows === 1 ? '' : 's'}: {check.created} new product{check.created === 1 ? '' : 's'}, {check.updated} update
                  {check.updated === 1 ? '' : 's'}.
                  {check.categoriesCreated.length > 0 && <div className="text-xs">New categories: {check.categoriesCreated.join(', ')}</div>}
                  {check.brandsCreated.length > 0 && <div className="text-xs">New brands: {check.brandsCreated.join(', ')}</div>}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-xl bg-coral/10 p-3 text-coral">
                  <TriangleAlert className="size-5 shrink-0" />
                  <span>
                    <b>
                      {check.errorCount} problem{check.errorCount === 1 ? '' : 's'}
                    </b>{' '}
                    to fix in the file — nothing was saved. Fix them and choose the file again.
                  </span>
                </div>
                <div className="max-h-56 overflow-auto rounded-xl border border-line">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-mute">
                      <tr>
                        <th className="px-3! py-2!">Row</th>
                        <th className="px-3! py-2!">Column</th>
                        <th className="px-3! py-2!">Problem</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {check.errors.map((e, i) => (
                        <tr key={i}>
                          <td className="px-3! py-1.5! tabular-nums">{e.row}</td>
                          <td className="px-3! py-1.5! font-mono text-xs">{e.column ?? '—'}</td>
                          <td className="px-3! py-1.5!">{e.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {check.errorCount > check.errors.length && <p className="text-xs text-mute">Showing the first {check.errors.length}.</p>}
              </div>
            ))}

          <details className="rounded-xl bg-bg p-3">
            <summary className="cursor-pointer font-semibold">What goes in each column</summary>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[150px_1fr]">
              {COLUMNS.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono font-semibold">{k}</dt>
                  <dd className="text-sub">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-mute">Leave a cell empty to keep what the product already has. The template has every column and two example rows.</p>
          </details>

          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Btn onClick={onClose}>Cancel</Btn>
            <Btn tone="primary" disabled={!check || check.errorCount > 0 || !file} busy={busy === 'import'} onClick={() => void run()}>
              Import {check && !check.errorCount ? `${check.rows} product${check.rows === 1 ? '' : 's'}` : ''}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex items-center gap-2 font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-blue/10 text-xs text-blue">{n}</span>
        {title}
      </div>
      {children}
    </li>
  );
}
