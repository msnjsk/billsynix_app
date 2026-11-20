/**
 * Development seed: a demo supermarket with two branches, a ~60-item catalogue and branch prices.
 * Goes through the same services as the API (registration, CSV import, price lists), so the data
 * obeys every business rule. Safe to run repeatedly — existing data is updated, not duplicated.
 *
 *   npm run db:seed          (uses DATABASE_URL from .env)
 *
 * Sign in as owner@demo.test / demo-password-123. Brands are fictional; GST rates and HSN codes
 * are plausible test data, not tax advice.
 */
import 'reflect-metadata';
import 'dotenv/config';
import type { z } from 'zod';
import { JwtService } from '@nestjs/jwt';
import { loadEnv } from '../src/config/env.js';
import { StorageService } from '../src/storage/storage.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AccessService } from '../src/access/access.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { SessionService } from '../src/auth/session.service.js';
import { TenantsService } from '../src/tenants/tenants.service.js';
import { registerTenantSchema } from '../src/tenants/tenants.schemas.js';
import { StoresService } from '../src/stores/stores.service.js';
import { createStoreSchema } from '../src/stores/stores.schemas.js';
import { TaxonomyService } from '../src/catalogue/taxonomy.service.js';
import { ImportService } from '../src/catalogue/import.service.js';
import { PriceListsService } from '../src/catalogue/price-lists.service.js';
import { LedgerService } from '../src/inventory/ledger.service.js';
import { AdjustmentsService } from '../src/inventory/adjustments.service.js';
import { StockService } from '../src/inventory/stock.service.js';
import { SuppliersService } from '../src/purchasing/suppliers.service.js';
import { PurchaseOrdersService } from '../src/purchasing/purchase-orders.service.js';
import { ReceiptsService } from '../src/purchasing/receipts.service.js';
import { PaymentsService } from '../src/purchasing/payments.service.js';
import { SalesService } from '../src/sales/sales.service.js';
import { CashSessionsService } from '../src/sales/cash-sessions.service.js';
import { createSaleSchema, quoteSchema } from '../src/sales/sales.schemas.js';
import {
  createGrnSchema,
  createPaymentSchema,
  createPoSchema,
  createSupplierSchema,
} from '../src/purchasing/purchasing.schemas.js';
import { gtinCheckDigit } from '../src/catalogue/barcode.js';
import { ALL_PERMISSIONS } from '../src/access/permissions.js';
import { gstinCheckChar } from '../src/common/gst.js';
import { toCsv } from '../src/common/csv.js';
import type { AuthContext } from '../src/auth/auth-context.js';

const OWNER_EMAIL = 'owner@demo.test';
const OWNER_PASSWORD = 'demo-password-123';
const PAN = 'AABCS1429B';
const GSTIN = `33${PAN}1Z${gstinCheckChar(`33${PAN}1Z`)}`;

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  process.stderr.write('Refusing to seed demo data in production.\n');
  process.exit(1);
}

// tsx (esbuild) doesn't emit decorator metadata, so services are wired by hand.
const prisma = new PrismaService(env);
const audit = new AuditService(prisma);
const access = new AccessService(prisma);
const jwt = new JwtService({
  secret: env.JWT_ACCESS_SECRET,
  signOptions: { algorithm: 'HS256', issuer: 'billing-api' },
});
const sessions = new SessionService(prisma, new TokenService(jwt), audit);
const tenants = new TenantsService(prisma, access, audit, sessions, new StorageService(env));
const stores = new StoresService(prisma, audit);
const taxonomy = new TaxonomyService(prisma, audit);
const importer = new ImportService(prisma, audit, taxonomy);
const priceLists = new PriceListsService(prisma, audit);
const adjustments = new AdjustmentsService(prisma, audit, new LedgerService());
const stock = new StockService(prisma, audit, taxonomy);
const ledger = new LedgerService();
const suppliers = new SuppliersService(prisma, audit);
const purchaseOrders = new PurchaseOrdersService(prisma, audit);
const receipts = new ReceiptsService(prisma, audit, ledger);
const payments = new PaymentsService(prisma, audit);
const sales = new SalesService(prisma, audit, ledger);
const cashSessions = new CashSessionsService(prisma, audit);
const meta = { requestId: 'seed' };

/** [sku, name, category, brand, unit, tax, hsn, mrp, selling, cost, caseQty?] */
type Item = [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number?,
];
const ITEMS: Item[] = [
  [
    'GR-ATTA-1',
    'Gehu Gold Atta 1kg',
    'Staples > Flour',
    'Gehu Gold',
    'PCS',
    '5',
    '1101',
    '68',
    '64',
    '55',
  ],
  [
    'GR-ATTA-5',
    'Gehu Gold Atta 5kg',
    'Staples > Flour',
    'Gehu Gold',
    'PCS',
    '5',
    '1101',
    '320',
    '299',
    '255',
    4,
  ],
  [
    'GR-MAIDA-1',
    'Gehu Gold Maida 1kg',
    'Staples > Flour',
    'Gehu Gold',
    'PCS',
    '5',
    '1101',
    '62',
    '58',
    '48',
  ],
  [
    'GR-RAVA-500',
    'Gehu Gold Bombay Rava 500g',
    'Staples > Flour',
    'Gehu Gold',
    'PCS',
    '5',
    '1103',
    '38',
    '36',
    '29',
  ],
  [
    'GR-PONNI-10',
    'Sagar Ponni Rice 10kg',
    'Staples > Rice',
    'Sagar',
    'PCS',
    '5',
    '1006',
    '850',
    '799',
    '700',
  ],
  [
    'GR-PONNI-5',
    'Sagar Ponni Rice 5kg',
    'Staples > Rice',
    'Sagar',
    'PCS',
    '5',
    '1006',
    '440',
    '415',
    '362',
  ],
  [
    'GR-BASMATI-1',
    'Sagar Basmati Rice 1kg',
    'Staples > Rice',
    'Sagar',
    'PCS',
    '5',
    '1006',
    '165',
    '149',
    '122',
  ],
  [
    'GR-IDLIRICE-5',
    'Sagar Idli Rice 5kg',
    'Staples > Rice',
    'Sagar',
    'PCS',
    '5',
    '1006',
    '310',
    '295',
    '250',
  ],
  [
    'GR-TOOR-1',
    'Toor Dal 1kg',
    'Staples > Dal & Pulses',
    'Kaveri Foods',
    'PCS',
    '5',
    '0713',
    '175',
    '165',
    '142',
  ],
  [
    'GR-URAD-1',
    'Urad Dal 1kg',
    'Staples > Dal & Pulses',
    'Kaveri Foods',
    'PCS',
    '5',
    '0713',
    '160',
    '152',
    '130',
  ],
  [
    'GR-MOONG-500',
    'Moong Dal 500g',
    'Staples > Dal & Pulses',
    'Kaveri Foods',
    'PCS',
    '5',
    '0713',
    '78',
    '74',
    '62',
  ],
  [
    'GR-CHANA-1',
    'Bengal Gram 1kg',
    'Staples > Dal & Pulses',
    'Kaveri Foods',
    'PCS',
    '5',
    '0713',
    '110',
    '104',
    '88',
  ],
  [
    'GR-SUGAR-1',
    'Sugar 1kg',
    'Staples > Sugar & Salt',
    'Kaveri Foods',
    'PCS',
    '5',
    '1701',
    '48',
    '46',
    '41',
  ],
  [
    'GR-SALT-1',
    'Iodised Salt 1kg',
    'Staples > Sugar & Salt',
    'Samudra',
    'PCS',
    'nil',
    '2501',
    '28',
    '26',
    '21',
  ],
  [
    'GR-SUNOIL-1',
    'Kavya Sunflower Oil 1L',
    'Staples > Oil & Ghee',
    'Kavya',
    'PCS',
    '5',
    '1512',
    '155',
    '145',
    '128',
    12,
  ],
  [
    'GR-GROUNDNUT-1',
    'Kavya Groundnut Oil 1L',
    'Staples > Oil & Ghee',
    'Kavya',
    'PCS',
    '5',
    '1508',
    '210',
    '199',
    '176',
  ],
  [
    'GR-SESAME-500',
    'Kavya Gingelly Oil 500ml',
    'Staples > Oil & Ghee',
    'Kavya',
    'PCS',
    '5',
    '1515',
    '180',
    '172',
    '150',
  ],
  [
    'GR-GHEE-500',
    'Amudham Ghee 500ml',
    'Staples > Oil & Ghee',
    'Amudham',
    'PCS',
    '5',
    '0405',
    '360',
    '345',
    '305',
  ],
  [
    'DC-MILK-500',
    'Amudham Toned Milk 500ml',
    'Dairy > Milk',
    'Amudham',
    'PCS',
    'nil',
    '0401',
    '27',
    '27',
    '24',
  ],
  [
    'DC-MILK-1',
    'Amudham Toned Milk 1L',
    'Dairy > Milk',
    'Amudham',
    'PCS',
    'nil',
    '0401',
    '54',
    '54',
    '48',
  ],
  [
    'DC-CURD-400',
    'Amudham Curd 400g',
    'Dairy > Curd & Paneer',
    'Amudham',
    'PCS',
    '5',
    '0403',
    '40',
    '38',
    '32',
  ],
  [
    'DC-PANEER-200',
    'Amudham Paneer 200g',
    'Dairy > Curd & Paneer',
    'Amudham',
    'PCS',
    'nil',
    '0406',
    '95',
    '90',
    '76',
  ],
  [
    'DC-BUTTER-100',
    'Amudham Butter 100g',
    'Dairy > Curd & Paneer',
    'Amudham',
    'PCS',
    '5',
    '0405',
    '62',
    '60',
    '52',
  ],
  [
    'DC-EGGS-30',
    'Farm Eggs Tray of 30',
    'Dairy > Eggs',
    'Kozhi Farms',
    'PCS',
    'nil',
    '0407',
    '210',
    '195',
    '170',
  ],
  [
    'DC-EGGS-6',
    'Farm Eggs Pack of 6',
    'Dairy > Eggs',
    'Kozhi Farms',
    'PCS',
    'nil',
    '0407',
    '45',
    '42',
    '35',
  ],
  [
    'BV-COLA-750',
    'Fizzo Cola 750ml',
    'Beverages > Soft Drinks',
    'Fizzo',
    'PCS',
    '40',
    '2202',
    '45',
    '45',
    '36',
    24,
  ],
  [
    'BV-LEMON-750',
    'Fizzo Lemon 750ml',
    'Beverages > Soft Drinks',
    'Fizzo',
    'PCS',
    '40',
    '2202',
    '45',
    '45',
    '36',
    24,
  ],
  [
    'BV-WATER-1',
    'Neer Packaged Water 1L',
    'Beverages > Water',
    'Neer',
    'PCS',
    '5',
    '2201',
    '20',
    '20',
    '13',
    12,
  ],
  [
    'BV-MANGO-1',
    'Fizzo Mango Drink 1L',
    'Beverages > Juices',
    'Fizzo',
    'PCS',
    '5',
    '2202',
    '99',
    '95',
    '78',
  ],
  [
    'BV-TEA-250',
    'Malai Tea 250g',
    'Beverages > Tea & Coffee',
    'Malai',
    'PCS',
    '5',
    '0902',
    '145',
    '138',
    '115',
  ],
  [
    'BV-COFFEE-200',
    'Kumbakonam Filter Coffee 200g',
    'Beverages > Tea & Coffee',
    'Malai',
    'PCS',
    '5',
    '0901',
    '190',
    '182',
    '150',
  ],
  [
    'SN-MARIE-250',
    'Crunchee Marie 250g',
    'Snacks > Biscuits',
    'Crunchee',
    'PCS',
    '5',
    '1905',
    '40',
    '38',
    '31',
    24,
  ],
  [
    'SN-CREAM-100',
    'Crunchee Choco Cream 100g',
    'Snacks > Biscuits',
    'Crunchee',
    'PCS',
    '5',
    '1905',
    '30',
    '30',
    '24',
    48,
  ],
  [
    'SN-SALTED-200',
    'Crunchee Salted Crackers 200g',
    'Snacks > Biscuits',
    'Crunchee',
    'PCS',
    '5',
    '1905',
    '35',
    '33',
    '27',
  ],
  [
    'SN-MIXTURE-200',
    'Madurai Mixture 200g',
    'Snacks > Namkeen',
    'Madurai Snacks',
    'PCS',
    '5',
    '2106',
    '60',
    '56',
    '45',
  ],
  [
    'SN-MURUKKU-200',
    'Madurai Murukku 200g',
    'Snacks > Namkeen',
    'Madurai Snacks',
    'PCS',
    '5',
    '2106',
    '65',
    '62',
    '50',
  ],
  [
    'SN-CHIPS-50',
    'Crispo Potato Chips 50g',
    'Snacks > Namkeen',
    'Crispo',
    'PCS',
    '5',
    '2005',
    '20',
    '20',
    '15',
    30,
  ],
  [
    'SN-CHOCO-40',
    'Cocoa Joy Chocolate 40g',
    'Snacks > Chocolates',
    'Cocoa Joy',
    'PCS',
    '5',
    '1806',
    '40',
    '40',
    '31',
  ],
  [
    'BK-BREAD-400',
    'Bake House Sandwich Bread 400g',
    'Bakery',
    'Bake House',
    'PCS',
    'nil',
    '1905',
    '45',
    '45',
    '37',
  ],
  [
    'BK-BUN-4',
    'Bake House Sweet Bun (4)',
    'Bakery',
    'Bake House',
    'PCS',
    'nil',
    '1905',
    '30',
    '30',
    '23',
  ],
  [
    'BK-RUSK-200',
    'Bake House Rusk 200g',
    'Bakery',
    'Bake House',
    'PCS',
    '5',
    '1905',
    '55',
    '52',
    '42',
  ],
  [
    'HH-DETERGENT-1',
    'Sudha Detergent Powder 1kg',
    'Household > Laundry',
    'Sudha',
    'PCS',
    '18',
    '3402',
    '135',
    '128',
    '104',
  ],
  [
    'HH-LIQUID-1',
    'Sudha Liquid Detergent 1L',
    'Household > Laundry',
    'Sudha',
    'PCS',
    '18',
    '3402',
    '230',
    '215',
    '178',
  ],
  [
    'HH-DISHBAR-200',
    'Sudha Dishwash Bar 200g',
    'Household > Cleaning',
    'Sudha',
    'PCS',
    '18',
    '3402',
    '25',
    '24',
    '18',
  ],
  [
    'HH-FLOOR-1',
    'Sudha Floor Cleaner 1L',
    'Household > Cleaning',
    'Sudha',
    'PCS',
    '18',
    '3808',
    '190',
    '179',
    '142',
  ],
  [
    'HH-AGARBATTI',
    'Deepam Agarbatti 100 sticks',
    'Household > Pooja',
    'Deepam',
    'PCS',
    '5',
    '3307',
    '60',
    '58',
    '44',
  ],
  [
    'HH-CAMPHOR-50',
    'Deepam Camphor 50g',
    'Household > Pooja',
    'Deepam',
    'PCS',
    '5',
    '2914',
    '75',
    '72',
    '56',
  ],
  [
    'PC-SOAP-100',
    'Malli Sandal Soap 100g',
    'Personal Care > Bath',
    'Malli',
    'PCS',
    '5',
    '3401',
    '45',
    '43',
    '34',
    48,
  ],
  [
    'PC-SHAMPOO-180',
    'Malli Herbal Shampoo 180ml',
    'Personal Care > Hair',
    'Malli',
    'PCS',
    '5',
    '3305',
    '160',
    '152',
    '120',
  ],
  [
    'PC-COCOIL-200',
    'Malli Coconut Hair Oil 200ml',
    'Personal Care > Hair',
    'Malli',
    'PCS',
    '5',
    '1513',
    '110',
    '105',
    '84',
  ],
  [
    'PC-PASTE-150',
    'Malli Toothpaste 150g',
    'Personal Care > Oral Care',
    'Malli',
    'PCS',
    '5',
    '3306',
    '99',
    '94',
    '74',
  ],
  [
    'PC-BRUSH',
    'Malli Toothbrush Medium',
    'Personal Care > Oral Care',
    'Malli',
    'PCS',
    '5',
    '9603',
    '40',
    '38',
    '28',
  ],
  [
    'FV-TOMATO',
    'Tomato',
    'Fruits & Vegetables > Vegetables',
    '',
    'KG',
    'nil',
    '0702',
    '',
    '40',
    '28',
  ],
  [
    'FV-ONION',
    'Onion',
    'Fruits & Vegetables > Vegetables',
    '',
    'KG',
    'nil',
    '0703',
    '',
    '45',
    '32',
  ],
  [
    'FV-POTATO',
    'Potato',
    'Fruits & Vegetables > Vegetables',
    '',
    'KG',
    'nil',
    '0701',
    '',
    '38',
    '27',
  ],
  [
    'FV-BANANA',
    'Banana (Robusta)',
    'Fruits & Vegetables > Fruits',
    '',
    'KG',
    'nil',
    '0803',
    '',
    '50',
    '36',
  ],
  [
    'FV-APPLE',
    'Apple (Shimla)',
    'Fruits & Vegetables > Fruits',
    '',
    'KG',
    'nil',
    '0808',
    '',
    '180',
    '140',
  ],
  [
    'FV-CORIANDER',
    'Coriander Leaves (bunch)',
    'Fruits & Vegetables > Vegetables',
    '',
    'PCS',
    'nil',
    '0709',
    '',
    '10',
    '6',
  ],
  [
    'FZ-PEAS-500',
    'Frost Green Peas 500g',
    'Frozen',
    'Frost',
    'PCS',
    '5',
    '0710',
    '120',
    '115',
    '92',
  ],
  [
    'FZ-ICECREAM-500',
    'Frost Vanilla Ice Cream 500ml',
    'Frozen',
    'Frost',
    'PCS',
    '5',
    '2105',
    '150',
    '145',
    '112',
  ],
];

/** Deterministic EAN-13s: 890 7001 <5-digit item> <check> for units, 890 7002 … for cases. */
const ean = (company: string, n: number) => {
  const body = `890${company}${String(n).padStart(5, '0')}`;
  return body + gtinCheckDigit(body);
};

/** Kept per batch with expiry (short shelf life). */
const BATCHED = new Set(['DC-PANEER-200', 'DC-CURD-400']);

function catalogueCsv(): Buffer {
  const rows = ITEMS.map(
    (
      [sku, name, category, brand, unit, tax, hsn, mrp, sp, cost, caseQty],
      i,
    ) => {
      const loose = sku.startsWith('FV-');
      const barcodes = loose
        ? ''
        : [
            ean('7001', i + 1),
            ...(caseQty ? [`${ean('7002', i + 1)}*${caseQty}`] : []),
          ].join('|');
      const variantOf = sku === 'GR-ATTA-5' ? 'GR-ATTA-1' : '';
      return [
        sku,
        name,
        category,
        brand,
        unit,
        tax,
        hsn,
        mrp,
        sp,
        cost,
        barcodes,
        variantOf,
        variantOf ? '5 kg' : '',
        BATCHED.has(sku) ? 'yes' : 'no',
      ];
    },
  );
  return Buffer.from(
    toCsv([
      [
        'sku',
        'name',
        'category',
        'brand',
        'unit',
        'tax',
        'hsn',
        'mrp',
        'selling_price',
        'purchase_cost',
        'barcodes',
        'parent_sku',
        'variant_label',
        'tracks_batches',
      ],
      ...rows,
    ]),
    'utf8',
  );
}

async function ownerContext(): Promise<AuthContext> {
  const user = await prisma.user.findUnique({ where: { email: OWNER_EMAIL } });
  let tenantId: string;
  let userId: string;
  if (!user) {
    const input = registerTenantSchema.parse({
      business: {
        displayName: 'Sri Lakshmi Supermarket',
        legalName: 'Sri Lakshmi Retail Private Limited',
        businessType: 'supermarket',
        registration: 'REGULAR',
        gstin: GSTIN,
        stateCode: '33',
        phone: '+91 44 2626 1234',
        email: OWNER_EMAIL,
        address: {
          line1: '12, 2nd Avenue',
          city: 'Chennai',
          pincode: '600040',
        },
      },
      owner: {
        name: 'Lakshmi Narayanan',
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
      },
      hq: { code: 'ANR', name: 'Anna Nagar' },
    });
    const res = await tenants.register(input, meta);
    tenantId = res.tenant.id;
    userId = res.user.id;
    process.stdout.write(`Created Sri Lakshmi Supermarket (${tenantId}).\n`);
  } else {
    const m = await prisma.membership.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });
    tenantId = m.tenantId;
    userId = user.id;
  }
  const membership = await prisma.membership.findFirstOrThrow({
    where: { tenantId, userId },
  });
  return {
    userId,
    tenantId,
    membershipId: membership.id,
    roles: ['owner'],
    permissions: new Set(ALL_PERMISSIONS),
    storeIds: 'ALL',
    subscription: { status: 'TRIALING', writable: true, plan: 'business' },
    sessionId: 'seed',
    sessionFamilyId: 'seed',
    sessionKind: 'PASSWORD',
  };
}

async function main() {
  await access.onModuleInit(); // permission catalogue
  const auth = await ownerContext();

  const tnagar =
    (await prisma.withTenant(auth.tenantId, (tx) =>
      tx.store.findFirst({ where: { tenantId: auth.tenantId, code: 'TNR' } }),
    )) ??
    (await stores.create(
      auth,
      createStoreSchema.parse({
        code: 'TNR',
        name: 'T. Nagar',
        address: {
          line1: '45, Usman Road',
          city: 'Chennai',
          pincode: '600017',
          stateCode: '33',
        },
        gstin: GSTIN,
        managerName: 'Priya Raman',
      }),
      meta,
    ));

  const result = await importer.importCsv(
    auth,
    { buffer: catalogueCsv() },
    false,
    meta,
  );
  if (!result.committed) {
    process.stderr.write(
      `Catalogue import failed:\n${JSON.stringify(result.errors, null, 2)}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `Catalogue: ${result.created} created, ${result.updated} updated, ${result.categoriesCreated.length} categories and ${result.brandsCreated.length} brands added.\n`,
  );

  // T. Nagar runs a little cheaper on a few fast movers.
  const existing = (await priceLists.list(auth)).data.find(
    (l) => l.name === 'T. Nagar prices',
  );
  const list =
    existing ??
    (await priceLists.create(auth, { name: 'T. Nagar prices' }, meta));
  const deals: Record<string, string> = {
    'GR-SUNOIL-1': '139.00',
    'GR-PONNI-10': '780.00',
    'SN-MARIE-250': '36.00',
    'HH-DETERGENT-1': '122.00',
    'DC-EGGS-30': '189.00',
  };
  const products = await prisma.withTenant(auth.tenantId, (tx) =>
    tx.product.findMany({
      where: { tenantId: auth.tenantId, sku: { in: Object.keys(deals) } },
      select: { id: true, sku: true },
    }),
  );
  await priceLists.setPrices(
    auth,
    list.id,
    {
      items: products.map((p) => ({
        productId: p.id,
        sellingPrice: deals[p.sku] ?? '0',
      })),
    },
    meta,
  );
  await priceLists.assign(auth, tnagar.id, { priceListId: list.id }, meta);
  process.stdout.write(
    `Branch prices: ${products.length} products on "T. Nagar prices".\n`,
  );

  await seedStock(auth, tnagar.id);
  await seedPurchasing(auth);
  await seedSales(auth);
  process.stdout.write(`Sign in as ${OWNER_EMAIL} / ${OWNER_PASSWORD}\n`);
}

/** Opening stock (once per branch) and reorder levels; T. Nagar holds about half of Anna Nagar. */
async function seedStock(auth: AuthContext, tnagarId: string) {
  const t = auth.tenantId;
  const { hq, items } = await prisma.withTenant(t, async (tx) => ({
    hq: await tx.store.findFirstOrThrow({ where: { tenantId: t, isHq: true } }),
    items: await tx.product.findMany({
      where: { tenantId: t, trackInventory: true },
      include: { unit: true },
      orderBy: { sku: 'asc' },
    }),
  }));
  const expiry = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const branches = [
    [hq.id, 'ANR', 1],
    [tnagarId, 'TNR', 0.5],
  ] as const;
  for (const [storeId, code, share] of branches) {
    const started = await prisma.withTenant(t, (tx) =>
      tx.stockMovement.count({ where: { tenantId: t, storeId } }),
    );
    if (!started) {
      const lines = items.flatMap((p, i) => {
        const base = p.unit.decimals ? 25.5 : 24 + ((i * 7) % 60);
        const qty = p.unit.decimals
          ? (base * share).toFixed(3)
          : String(Math.max(1, Math.round(base * share)));
        const unitCost = (p.purchaseCost ?? p.sellingPrice.times(0.8)).toFixed(
          2,
        );
        if (!p.tracksBatches) return [{ productId: p.id, qty, unitCost }];
        const half = String(Math.max(1, Math.round(Number(qty) / 2)));
        const tag = p.sku.slice(3, 6);
        return [
          {
            productId: p.id,
            qty: half,
            unitCost,
            batchNo: `${tag}-A`,
            expiryDate: expiry(4),
          },
          {
            productId: p.id,
            qty: half,
            unitCost,
            batchNo: `${tag}-B`,
            expiryDate: expiry(12),
          },
        ];
      });
      await adjustments.create(
        auth,
        storeId,
        { reason: 'OPENING', note: 'Demo opening stock', items: lines },
        `seed-opening-${code}-${t}`,
        meta,
      );
      process.stdout.write(
        `Opening stock: ${lines.length} lines at ${code}.\n`,
      );
    }
    for (const p of items)
      await stock.setReorder(
        auth,
        storeId,
        p.id,
        p.unit.decimals
          ? { reorderLevel: '8.000', reorderQty: '20.000' }
          : { reorderLevel: '15.000', reorderQty: '48.000' },
        meta,
      );
  }
}

/** Suppliers, a part-delivered PO with its receipt, a payment and an overdue bill (once). */
async function seedPurchasing(auth: AuthContext) {
  const t = auth.tenantId;
  const exists = await prisma.withTenant(t, (tx) =>
    tx.supplier.count({ where: { tenantId: t } }),
  );
  if (exists) return;
  const pan = (p: string) => (state: string) =>
    `${state}${p}1Z${gstinCheckChar(`${state}${p}1Z`)}`;
  const balaji = await suppliers.create(
    auth,
    createSupplierSchema.parse({
      name: 'Sri Balaji Traders',
      contactName: 'Venkatesh R',
      phone: '+91 98400 11223',
      gstin: pan('AAKFS2231Q')('33'),
      city: 'Chennai',
      supplies: 'Rice, dal, flour, sugar, oil',
      creditDays: 15,
    }),
    meta,
  );
  await suppliers.create(
    auth,
    createSupplierSchema.parse({
      name: 'Amudham Dairy Co-op',
      phone: '+91 44 2433 9000',
      gstin: pan('AABCA7781K')('33'),
      supplies: 'Milk, curd, paneer, butter, ghee',
      creditDays: 7,
    }),
    meta,
  );
  const fizzo = await suppliers.create(
    auth,
    createSupplierSchema.parse({
      name: 'Fizzo Beverages',
      gstin: pan('AADCF5521M')('29'),
      city: 'Bengaluru',
      supplies: 'Soft drinks, juices, water',
      creditDays: 30,
    }),
    meta,
  );
  await suppliers.create(
    auth,
    createSupplierSchema.parse({
      name: 'Koyambedu Fresh Vegetables',
      stateCode: '33',
      supplies: 'Vegetables and fruit',
      creditDays: 0,
    }),
    meta,
  );

  const { hq, ids } = await prisma.withTenant(t, async (tx) => ({
    hq: await tx.store.findFirstOrThrow({ where: { tenantId: t, isHq: true } }),
    ids: new Map(
      (
        await tx.product.findMany({
          where: { tenantId: t },
          select: { id: true, sku: true },
        })
      ).map((p) => [p.sku, p.id]),
    ),
  }));
  const id = (sku: string) => ids.get(sku) ?? '';

  const po = await purchaseOrders.create(
    auth,
    createPoSchema.parse({
      supplierId: balaji.id,
      storeId: hq.id,
      notes: 'Weekly staples',
      items: [
        { productId: id('GR-PONNI-10'), qty: 20, rate: '700', discountPct: 2 },
        { productId: id('GR-TOOR-1'), qty: 40, rate: '142' },
        { productId: id('GR-SUGAR-1'), qty: 50, rate: '41' },
        { productId: id('GR-SUNOIL-1'), qty: 36, rate: '128' },
      ],
    }),
    meta,
  );
  await purchaseOrders.submit(auth, po.id, meta);
  const grn = await receipts.create(
    auth,
    createGrnSchema.parse({
      supplierId: balaji.id,
      storeId: hq.id,
      poId: po.id,
      supplierInvoiceNo: 'SBT/24/1187',
      items: [
        { productId: id('GR-PONNI-10'), receivedQty: 20, damagedQty: 1 },
        { productId: id('GR-TOOR-1'), receivedQty: 40 },
        { productId: id('GR-SUGAR-1'), receivedQty: 25 },
      ],
    }),
    `seed-grn-${t}`,
    meta,
  );
  await payments.create(
    auth,
    createPaymentSchema.parse({
      supplierId: balaji.id,
      amount: '10000',
      mode: 'BANK_TRANSFER',
      reference: 'NEFT 4471',
    }),
    `seed-pay-${t}`,
    meta,
  );
  await receipts.create(
    auth,
    createGrnSchema.parse({
      supplierId: fizzo.id,
      storeId: hq.id,
      receivedDate: new Date(Date.now() - 40 * 86_400_000)
        .toISOString()
        .slice(0, 10),
      supplierInvoiceNo: 'FZ-88213',
      items: [
        { productId: id('BV-COLA-750'), receivedQty: 48, rate: '34' },
        { productId: id('BV-WATER-1'), receivedQty: 60, rate: '12' },
      ],
    }),
    `seed-grn-fizzo-${t}`,
    meta,
  );
  process.stdout.write(
    `Purchasing: 4 suppliers, ${po.number} part-received on ${grn.body.number}, one payment, one overdue bill.\n`,
  );
}

/** A morning at Anna Nagar counter 1: three bills, then the drawer is counted and closed (once). */
async function seedSales(auth: AuthContext) {
  const t = auth.tenantId;
  const { counter, ids } = await prisma.withTenant(t, async (tx) => ({
    counter: await tx.counter.findFirstOrThrow({
      where: { tenantId: t, number: 1, store: { isHq: true } },
    }),
    ids: new Map(
      (
        await tx.product.findMany({
          where: { tenantId: t },
          select: { id: true, sku: true },
        })
      ).map((p) => [p.sku, p.id]),
    ),
  }));
  const done = await prisma.withTenant(t, (tx) =>
    tx.sale.count({ where: { tenantId: t } }),
  );
  if (done) return;
  const id = (sku: string) => ids.get(sku) ?? '';
  const session = await cashSessions.open(
    auth,
    { counterId: counter.id, openingFloat: '2000.00' },
    meta,
  );
  const bill = async (
    n: number,
    lines: { productId: string; qty: string }[],
    pay: (payable: string) => {
      method: 'CASH' | 'UPI' | 'CARD';
      amount: string;
      tendered?: string;
      reference?: string;
    }[],
    extra: Partial<z.input<typeof createSaleSchema>> = {},
  ) => {
    const q = await sales.quote(
      auth,
      quoteSchema.parse({ counterId: counter.id, lines, ...extra }),
    );
    return sales.create(
      auth,
      createSaleSchema.parse({
        counterId: counter.id,
        lines,
        payments: pay(q.totals.payable),
        expectedPayable: q.totals.payable,
        ...extra,
      }),
      `seed-sale-${n}-${t}`,
      meta,
    );
  };
  const s1 = await bill(
    1,
    [
      { productId: id('GR-ATTA-5'), qty: '1' },
      { productId: id('DC-MILK-1'), qty: '2' },
      { productId: id('FV-TOMATO'), qty: '1.250' },
    ],
    (p) => [{ method: 'CASH', amount: p, tendered: '500.00' }],
  );
  await bill(
    2,
    [
      { productId: id('GR-SUNOIL-1'), qty: '2' },
      { productId: id('SN-MARIE-250'), qty: '3' },
    ],
    (p) => [{ method: 'UPI', amount: p, reference: 'UTR4402918836' }],
  );
  await bill(
    3,
    [
      { productId: id('HH-DETERGENT-1'), qty: '1' },
      { productId: id('PC-SOAP-100'), qty: '4' },
      { productId: id('BV-COLA-750'), qty: '2' },
    ],
    (p) => [{ method: 'CASH', amount: p }],
    {
      billDiscount: { kind: 'PCT', value: '5.00' },
      buyer: { name: 'Meena', phone: '+91 98765 43210' },
    },
  );
  const live = await cashSessions.get(auth, session.id);
  await cashSessions.close(
    auth,
    session.id,
    { countedCash: live.expectedCash ?? '0', note: 'Morning shift' },
    meta,
  );
  process.stdout.write(
    `Sales: 3 bills from ${s1.body.invoiceNo} (one UPI awaiting verification), drawer closed.\n`,
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
