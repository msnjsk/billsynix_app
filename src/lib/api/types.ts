/**
 * Response shapes of the API endpoints the frontend uses (request bodies come typed from the
 * generated OpenAPI `schema.d.ts`). Money and quantities are decimal strings ("240.50"); turn
 * them into numbers only for display (`num`).
 */

export const num = (s: string | null | undefined) => (s == null ? 0 : Number(s));

export type Page<T> = { data: T[]; meta: { page: number; pageSize: number; total: number } };

/* ---------- auth ---------- */

export type LoginResult =
  | { status: 'AUTHENTICATED'; accessToken: string; expiresIn: number; user: { id: string; name: string; email: string }; tenant: { id: string; displayName: string } }
  | { status: 'SELECT_TENANT'; tenants: { id: string; displayName: string }[] };

export type Me = {
  user: { id: string; name: string; email: string };
  tenant: { id: string; displayName: string; businessType: string };
  membership: { id: string; roles: string[]; permissions: string[]; storeIds: string[] | null };
  session: { id: string; kind: 'PASSWORD' | 'PIN'; device: { id: string; counterId: string; storeId: string } | null };
  businesses: { id: string; displayName: string }[];
};

export type Tenant = {
  id: string;
  displayName: string;
  legalName: string | null;
  businessType: string;
  registration: 'REGULAR' | 'COMPOSITION' | 'UNREGISTERED';
  gstin: string | null;
  stateCode: string;
  phone: string | null;
  email: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; pincode: string | null };
  /** Set when a shop logo was uploaded; fetch it from /tenants/current/logo. */
  logo?: { version: string } | null;
};

/* ---------- branches ---------- */

export type Store = {
  id: string;
  code: string;
  name: string;
  kind: 'STORE' | 'WAREHOUSE';
  isHq: boolean;
  address: { line1: string; line2: string | null; city: string; pincode: string; stateCode: string };
  gstin: string | null;
  phone: string | null;
  managerName: string | null;
  monthlyTarget: string;
  openedOn: string | null;
  status: 'ACTIVE' | 'CLOSED';
};

export type Counter = { id: string; storeId: string; number: number; name: string; status: 'ACTIVE' | 'DISABLED' };

/* ---------- catalogue ---------- */

export type TaxRate = { id: string; name: string; kind: 'TAXABLE' | 'NIL_RATED' | 'EXEMPT' | 'NON_GST'; rate: number; cessRate: number; isActive: boolean };
export type Unit = { id: string; code: string; name: string; decimals: number; uqc: string; isActive: boolean };
export type Category = { id: string; name: string; parentId: string | null; path: string[]; isActive: boolean };

export type Product = {
  id: string;
  sku: string;
  name: string;
  receiptName: string | null;
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  unit: { id: string; code: string; decimals: number };
  taxRate: { id: string; name: string; kind: TaxRate['kind']; rate: number; cessRate: number };
  hsnCode: string | null;
  mrp: string | null;
  sellingPrice: string;
  purchaseCost?: string | null;
  storePrice?: { sellingPrice: string; source: 'PRICE_LIST' | 'PRODUCT' };
  priceIncludesTax: boolean;
  allowOpenPrice: boolean;
  trackInventory: boolean;
  tracksBatches: boolean;
  barcodes: { id: string; code: string; packQty: string; label: string | null; isPrimary: boolean }[];
  status: 'ACTIVE' | 'INACTIVE';
  version: number;
};

/* ---------- stock ---------- */

export type StockRow = {
  product: { id: string; sku: string; name: string; unit: string; tracksBatches: boolean };
  qty: string;
  status: 'OK' | 'LOW' | 'OUT';
  reorderLevel: string | null;
  reorderQty: string | null;
  inTransitIn: string;
  avgCost?: string;
  value?: string;
};

export type Movement = {
  id: string;
  seq: string;
  productId: string;
  batchId: string | null;
  type: string;
  qty: string;
  balanceAfter: string;
  unitCost?: string;
  refType: string;
  refId: string;
  reason: string | null;
  note: string | null;
  createdAt: string;
};

/* ---------- purchasing ---------- */

export type Supplier = {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  registered: boolean;
  stateCode: string;
  supplies: string | null;
  creditDays: number;
  balance?: string;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
};

export type Totals = { taxable: string; cgst: string; sgst: string; igst: string; cess: string; roundOff: string; total: string };

export type PurchaseOrder = {
  id: string;
  number: string;
  supplier: { id: string; name: string };
  store: { id: string; code: string; name: string };
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'SENT' | 'PARTIAL' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';
  orderDate: string;
  expectedDate: string | null;
  notes: string | null;
  totals: Totals;
  items: { id: string; product: { id: string; sku: string; name: string }; qty: string; rate: string; discountPct: number; gstRate: number; receivedQty: string; pendingQty: string }[];
};

export type GoodsReceipt = {
  id: string;
  number: string;
  supplier: { id: string; name: string };
  store: { id: string; code: string };
  po: { id: string; number: string | null } | null;
  receivedDate: string;
  supplierInvoiceNo: string | null;
  supplierInvoiceDate: string | null;
  dueDate: string;
  gstApplies: boolean;
  interState: boolean;
  totals: Totals;
  outstanding?: string;
  notes: string | null;
  items: {
    id: string;
    product: { id: string; sku: string; name: string };
    receivedQty: string;
    damagedQty: string;
    acceptedQty: string;
    orderedQty: string | null;
    rate: string;
    discountPct: number;
    gstRate: number;
    batch: { id: string; batchNo: string | null; expiryDate: string | null } | null;
  }[];
  createdByUserId: string;
};

export type PurchaseReturn = {
  id: string;
  number: string;
  supplier: { id: string };
  grn: { id: string } | null;
  returnDate: string;
  reason: string;
  totals: Totals;
  gstApplies: boolean;
  interState: boolean;
  items: { product: { id: string; sku: string; name: string }; qty: string; rate: string; discountPct: number; gstRate: number }[];
};

export type SupplierPayment = {
  id: string;
  number: string;
  supplier: { id: string };
  direction: 'OUT' | 'IN';
  amount: string;
  mode: 'BANK_TRANSFER' | 'UPI' | 'CHEQUE' | 'CASH';
  reference: string | null;
  paidOn: string;
  notes: string | null;
  allocations: { grnId: string; amount: string }[];
};

/* ---------- sales ---------- */

export type SaleItem = {
  id: string;
  lineNo: number;
  productId: string;
  sku: string;
  name: string;
  hsnCode: string | null;
  qty: string;
  unitPrice: string;
  final: string;
  taxable: string;
  gstRate: number;
  returnedQty: string;
};

export type Sale = {
  id: string;
  invoiceNo: string;
  documentType: 'TAX_INVOICE' | 'BILL_OF_SUPPLY';
  status: 'COMPLETED' | 'VOIDED';
  paymentStatus: 'PAID' | 'PENDING' | 'DUE' | 'REFUNDED';
  store: { id: string; code: string; name: string };
  counter: { id: string; number: number; name: string };
  cashierUserId: string;
  issuedAt: string;
  businessDate: string;
  buyer: { name: string | null; phone: string | null; gstin: string | null } | null;
  interState: boolean;
  totals: { gross: string; lineDiscounts: string; billDiscount: string; taxable: string; cgst: string; sgst: string; igst: string; total: string; roundOff: string; payable: string };
  changeGiven: string;
  refunded: string;
  items: SaleItem[];
  payments: { id: string; method: 'CASH' | 'UPI' | 'CARD'; amount: string; status: string; tendered: string | null; reference: string | null }[];
};

export type CashSession = {
  id: string;
  storeId: string;
  counterId: string;
  userId: string;
  status: 'OPEN' | 'PENDING_REVIEW' | 'CLOSED';
  openingFloat: string;
  cashSales: string;
  cashRefunds: string;
  expectedCash: string;
  countedCash: string | null;
  variance: string | null;
};

export type SalesSummary = {
  totals: { revenue: string; bills: number; averageBill: string; profit?: string };
  daily: { date: string; revenue: string; bills: number; profit?: string }[];
  byMethod: { method: string; amount: string; pending: string }[];
  byProduct: { productId: string; sku: string; name: string; units: string; revenue: string; cost?: string }[];
  hourly: { hour: number; bills: number; revenue: string }[];
};
