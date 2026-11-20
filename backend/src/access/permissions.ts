/**
 * Permission catalogue and system roles — the code form of
 * docs/phase-0/02-roles-permissions.md. Permission keys are synchronised into the
 * `permissions` table at start-up; system roles are created for each new business.
 */
export const PERMISSIONS = {
  'tenant:read': 'View the business profile',
  'tenant:update': 'Edit the business profile',
  'subscription:manage': 'Manage the subscription',
  'users:manage': 'Invite staff, assign roles and branches',
  'stores:manage': 'Create, edit and close branches',
  'counters:manage': 'Create and edit POS counters',
  'devices:register': 'Register and revoke POS devices',
  'products:read': 'View the product catalogue',
  'products:write': 'Edit products, barcodes and tax',
  'prices:write': 'Set branch prices',
  'inventory:read': 'View stock',
  'inventory:adjust': 'Adjust and count stock',
  'inventory:approve': 'Approve stock adjustments',
  'transfers:request': 'Request stock transfers',
  'transfers:dispatch': 'Dispatch stock transfers',
  'transfers:receive': 'Receive stock transfers',
  'suppliers:manage': 'Manage suppliers',
  'purchases:write': 'Create purchase orders, receipts and returns',
  'purchases:approve': 'Approve purchase orders',
  'supplier-payments:write': 'Record supplier payments',
  'sales:create': 'Bill customers',
  'sales:read': 'View sales',
  'sales:return': 'Process returns',
  'sales:void': 'Void sales',
  'discount:override': 'Give discounts above the limit',
  'cash:session': 'Open and close a cash drawer',
  'cash:reconcile': 'Reconcile cash sessions',
  'customers:read': 'View customers',
  'customers:write': 'Edit customers',
  'reports:sales': 'Sales reports',
  'reports:finance': 'Margin, GST and payables reports',
  'expenses:write': 'Record expenses',
  'audit:read': 'View the audit log',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

export type SystemRoleKey =
  | 'owner'
  | 'business_admin'
  | 'branch_manager'
  | 'inventory_manager'
  | 'cashier';

export type SystemRole = {
  key: SystemRoleKey;
  name: string;
  /** Tenant-wide roles see every branch; others only their assigned branches. */
  tenantWide: boolean;
  permissions: readonly PermissionKey[];
};

const without = (...drop: PermissionKey[]) =>
  ALL_PERMISSIONS.filter((p) => !drop.includes(p));

export const SYSTEM_ROLES: readonly SystemRole[] = [
  {
    key: 'owner',
    name: 'Business Owner',
    tenantWide: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    key: 'business_admin',
    name: 'Business Admin',
    tenantWide: true,
    permissions: without('subscription:manage'),
  },
  {
    key: 'branch_manager',
    name: 'Branch Manager',
    tenantWide: false,
    permissions: [
      'tenant:read',
      'users:manage',
      'counters:manage',
      'devices:register',
      'products:read',
      'prices:write',
      'inventory:read',
      'inventory:adjust',
      'inventory:approve',
      'transfers:request',
      'transfers:dispatch',
      'transfers:receive',
      'purchases:write',
      'purchases:approve',
      'sales:create',
      'sales:read',
      'sales:return',
      'sales:void',
      'discount:override',
      'cash:session',
      'cash:reconcile',
      'customers:read',
      'customers:write',
      'reports:sales',
      'expenses:write',
    ],
  },
  {
    key: 'inventory_manager',
    name: 'Inventory Manager',
    tenantWide: false,
    permissions: [
      'tenant:read',
      'products:read',
      'products:write',
      'inventory:read',
      'inventory:adjust',
      'transfers:request',
      'transfers:dispatch',
      'transfers:receive',
      'suppliers:manage',
      'purchases:write',
    ],
  },
  {
    key: 'cashier',
    name: 'Cashier',
    tenantWide: false,
    permissions: [
      'tenant:read',
      'products:read',
      'inventory:read',
      'sales:create',
      'sales:read',
      'sales:return',
      'cash:session',
      'customers:read',
      'customers:write',
    ],
  },
];

/** Branch managers may only create/edit members holding these roles (matrix: "cashiers only"). */
export const ROLES_A_BRANCH_MANAGER_MAY_ASSIGN: readonly SystemRoleKey[] = [
  'cashier',
];
