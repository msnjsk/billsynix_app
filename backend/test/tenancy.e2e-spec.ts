import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TokenService } from '../src/auth/token.service.js';
import { gstinCheckChar } from '../src/common/gst.js';

/** A valid GSTIN for a state and PAN (check digit computed). */
const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return first14 + gstinCheckChar(first14);
};
const randomPan = () => {
  const L = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${L()}${L()}${L()}P${L()}${String(Math.floor(Math.random() * 9000) + 1000)}${L()}`;
};

type Registered = {
  tenantId: string;
  userId: string;
  storeId: string;
  counterId: string;
  token: string;
  pan: string;
  email: string;
};

describe('Phase 2 — multi-tenant foundation (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) =>
      http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) =>
      http()
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body ?? {}),
    patch: (url: string, body: object) =>
      http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
  });

  async function register(name: string, state = '33'): Promise<Registered> {
    const pan = randomPan();
    const email = `owner-${randomUUID()}@example.test`;
    const res = await http()
      .post('/api/v1/tenants')
      .send({
        business: {
          displayName: name,
          businessType: 'supermarket',
          registration: 'REGULAR',
          gstin: gstin(state, pan),
          stateCode: state,
          phone: '+91 44 2626 1234',
          address: {
            line1: '12, 2nd Avenue',
            city: 'Chennai',
            pincode: '600040',
          },
        },
        owner: {
          name: `${name} Owner`,
          email,
          password: 'correct-horse-battery',
        },
        hq: { code: 'hq' },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return {
      tenantId: res.body.tenant.id,
      userId: res.body.user.id,
      storeId: res.body.store.id,
      counterId: res.body.counter.id,
      token: res.body.accessToken,
      pan,
      email,
    };
  }

  /** Staff sign in for real (Phase 3). */
  const tokenFor = async (m: { email: string }, tenantId: string) =>
    (
      await http()
        .post('/api/v1/auth/login')
        .send({ email: m.email, password: 'correct-horse-battery', tenantId })
        .expect(200)
    ).body.accessToken as string;
  const sidOf = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString())
      .sid as string;

  let A: Registered;
  let B: Registered;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    A = await register('Alpha Mart');
    B = await register('Beta Stores');
  });
  afterAll(async () => {
    await app.close();
  });

  /* ------------------------------------------------------------------ */
  describe('registration (onboarding API)', () => {
    it('creates business, owner, HQ branch and Counter 1, and the token works', async () => {
      const me = await as(A.token).get('/api/v1/tenants/current').expect(200);
      expect(me.body).toMatchObject({
        id: A.tenantId,
        displayName: 'Alpha Mart',
        registration: 'REGULAR',
        stateCode: '33',
      });
      expect(me.body.settings.approvalLimits.adjustmentValue).toBe(5000);

      const stores = await as(A.token).get('/api/v1/stores').expect(200);
      expect(stores.body.meta.total).toBe(1);
      expect(stores.body.data[0]).toMatchObject({
        code: 'HQ',
        isHq: true,
        kind: 'STORE',
        gstin: gstin('33', A.pan),
      });

      const counters = await as(A.token)
        .get(`/api/v1/stores/${A.storeId}/counters`)
        .expect(200);
      expect(counters.body.data).toEqual([
        expect.objectContaining({
          number: 1,
          name: 'Counter 1',
          status: 'ACTIVE',
        }),
      ]);

      const roles = await as(A.token).get('/api/v1/roles').expect(200);
      expect(roles.body.data.map((r: { key: string }) => r.key)).toEqual([
        'owner',
        'business_admin',
        'branch_manager',
        'inventory_manager',
        'cashier',
      ]);

      const audit = await prisma.auditLog.findFirst({
        where: { tenantId: A.tenantId, action: 'tenant.registered' },
      });
      expect(audit?.actorUserId).toBe(A.userId);
    });

    it('stores passwords as Argon2id hashes', async () => {
      const u = await prisma.user.findUniqueOrThrow({
        where: { id: A.userId },
      });
      expect(u.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('rejects a duplicate owner email with 409', async () => {
      const res = await http()
        .post('/api/v1/tenants')
        .send({
          business: {
            displayName: 'Dup',
            businessType: 'grocery',
            registration: 'UNREGISTERED',
            stateCode: '33',
            address: { line1: 'x', city: 'y', pincode: '600001' },
          },
          owner: {
            name: 'Dup',
            email: A.email.toUpperCase(),
            password: 'correct-horse-battery',
          },
          hq: { code: 'DP' },
        });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ALREADY_EXISTS');
    });

    it('validates GSTIN check digit, GSTIN/state match and required fields', async () => {
      const base = {
        business: {
          displayName: 'V',
          businessType: 'grocery',
          registration: 'REGULAR',
          stateCode: '33',
          address: { line1: 'x', city: 'y', pincode: '600001' },
        },
        owner: {
          name: 'V',
          email: `v-${randomUUID()}@example.test`,
          password: 'correct-horse-battery',
        },
        hq: { code: 'VV' },
      };
      const good = gstin('33', randomPan());
      const badCheck = good.slice(0, 14) + (good[14] === 'A' ? 'B' : 'A');
      const r1 = await http()
        .post('/api/v1/tenants')
        .send({ ...base, business: { ...base.business, gstin: badCheck } })
        .expect(400);
      expect(r1.body.error.details).toEqual([
        expect.objectContaining({
          field: 'business.gstin',
          issue: expect.stringMatching(/check digit/),
        }),
      ]);
      const r2 = await http()
        .post('/api/v1/tenants')
        .send({
          ...base,
          business: { ...base.business, gstin: gstin('29', randomPan()) },
        })
        .expect(400);
      expect(r2.body.error.details[0].issue).toMatch(/state/);
      const r3 = await http()
        .post('/api/v1/tenants')
        .send({
          ...base,
          business: {
            ...base.business,
            registration: 'UNREGISTERED',
            gstin: good,
          },
        })
        .expect(400);
      expect(r3.body.error.details[0].issue).toMatch(/unregistered/);
      const r4 = await http()
        .post('/api/v1/tenants')
        .send({ owner: base.owner })
        .expect(400);
      expect(r4.body.error.code).toBe('VALIDATION_FAILED');
      expect(
        r4.body.error.details.map((d: { field: string }) => d.field),
      ).toEqual(expect.arrayContaining(['business', 'hq']));
    });
  });

  /* ------------------------------------------------------------------ */
  describe('authentication foundation', () => {
    it('protected routes reject missing, malformed and tampered tokens', async () => {
      await http().get('/api/v1/stores').expect(401);
      await http()
        .get('/api/v1/stores')
        .set('Authorization', 'Bearer not-a-jwt')
        .expect(401);
      const [h, p] = A.token.split('.');
      const forgedPayload = Buffer.from(
        JSON.stringify({ sub: B.userId, tid: B.tenantId, mid: 'x' }),
      ).toString('base64url');
      await http()
        .get('/api/v1/stores')
        .set(
          'Authorization',
          `Bearer ${h}.${forgedPayload}.${A.token.split('.')[2]}`,
        )
        .expect(401);
      expect(p).toBeTruthy();
    });

    it('a validly signed token whose ids do not belong together is rejected', async () => {
      const aMembership = await prisma.membership.findFirstOrThrow({
        where: { tenantId: A.tenantId, userId: A.userId },
      });
      // A's user + A's membership, but claiming tenant B → 401 (tenant is never trusted from the client).
      const crossTenant = tokens.signAccess({
        sub: A.userId,
        tid: B.tenantId,
        mid: aMembership.id,
        sid: sidOf(A.token),
      });
      await http()
        .get('/api/v1/stores')
        .set('Authorization', `Bearer ${crossTenant}`)
        .expect(401);
      // A's membership, but someone else's user id → 401.
      const wrongUser = tokens.signAccess({
        sub: B.userId,
        tid: A.tenantId,
        mid: aMembership.id,
        sid: sidOf(A.token),
      });
      await http()
        .get('/api/v1/stores')
        .set('Authorization', `Bearer ${wrongUser}`)
        .expect(401);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('tenant isolation through the API', () => {
    let bCounter: string;
    let bDevice: string;
    let bMember: string;

    beforeAll(async () => {
      const dev = await as(B.token)
        .post(`/api/v1/counters/${B.counterId}/devices`, { name: 'B till' })
        .expect(201);
      bDevice = dev.body.device.id;
      bCounter = B.counterId;
      const m = await as(B.token)
        .post('/api/v1/memberships', {
          name: 'B cashier',
          email: `bc-${randomUUID()}@example.test`,
          password: 'correct-horse-battery',
          roleKeys: ['cashier'],
          storeIds: [B.storeId],
        })
        .expect(201);
      bMember = m.body.id;
    });

    it("lists only the caller's own data", async () => {
      const s = await as(A.token).get('/api/v1/stores').expect(200);
      expect(s.body.data.map((x: { id: string }) => x.id)).not.toContain(
        B.storeId,
      );
      const m = await as(A.token).get('/api/v1/memberships').expect(200);
      expect(m.body.data.map((x: { id: string }) => x.id)).not.toContain(
        bMember,
      );
    });

    it('every guessed id of another business answers 404 — read and write', async () => {
      const t = as(A.token);
      const checks: [string, Promise<request.Response>][] = [
        ['GET store', t.get(`/api/v1/stores/${B.storeId}`)],
        [
          'PATCH store',
          t.patch(`/api/v1/stores/${B.storeId}`, { name: 'Hijacked' }),
        ],
        ['close store', t.post(`/api/v1/stores/${B.storeId}/close`)],
        ['GET counters', t.get(`/api/v1/stores/${B.storeId}/counters`)],
        [
          'POST counter',
          t.post(`/api/v1/stores/${B.storeId}/counters`, { name: 'Sneaky' }),
        ],
        ['GET devices', t.get(`/api/v1/stores/${B.storeId}/devices`)],
        [
          'PATCH counter',
          t.patch(`/api/v1/counters/${bCounter}`, { name: 'Hijacked' }),
        ],
        [
          'register device',
          t.post(`/api/v1/counters/${bCounter}/devices`, { name: 'Rogue' }),
        ],
        ['revoke device', t.post(`/api/v1/devices/${bDevice}/revoke`)],
        ['GET member', t.get(`/api/v1/memberships/${bMember}`)],
        [
          'PATCH member',
          t.patch(`/api/v1/memberships/${bMember}`, { status: 'DISABLED' }),
        ],
      ];
      for (const [label, pending] of checks) {
        const res = await pending;
        expect(res.status, label).toBe(404);
        expect(res.body.error.code, label).toBe('NOT_FOUND');
      }
      // Nothing changed on B's side.
      const store = await as(B.token)
        .get(`/api/v1/stores/${B.storeId}`)
        .expect(200);
      expect(store.body).toMatchObject({ name: 'Chennai', status: 'ACTIVE' });
      const dev = await as(B.token)
        .get(`/api/v1/stores/${B.storeId}/devices`)
        .expect(200);
      expect(dev.body.data[0].status).toBe('ACTIVE');
    });

    it("can't attach another business's branch to its own staff", async () => {
      const res = await as(A.token).post('/api/v1/memberships', {
        name: 'Mole',
        email: `mole-${randomUUID()}@example.test`,
        password: 'correct-horse-battery',
        roleKeys: ['cashier'],
        storeIds: [B.storeId],
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('UNKNOWN_STORE');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('tenant isolation inside PostgreSQL (defence in depth)', () => {
    it('row-level security hides branch rows without a tenant context', async () => {
      const rows = await prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM stores`;
      expect(Number(rows[0]?.n)).toBe(0);
    });

    it('inside tenant A only A rows are visible, even with no WHERE clause', async () => {
      const ids = await prisma.withTenant(
        A.tenantId,
        (tx) =>
          tx.$queryRaw<{ tenant_id: string }[]>`SELECT tenant_id FROM stores`,
      );
      expect(ids.length).toBeGreaterThan(0);
      expect(new Set(ids.map((r) => r.tenant_id))).toEqual(
        new Set([A.tenantId]),
      );
    });

    it('writing a row for tenant B from tenant A context is rejected', async () => {
      await expect(
        prisma.withTenant(A.tenantId, (tx) =>
          tx.store.create({
            data: {
              tenantId: B.tenantId,
              code: 'ZZ',
              name: 'x',
              addressLine1: 'x',
              city: 'x',
              pincode: '600001',
              stateCode: '33',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security|row level security/i);
    });

    it('composite foreign keys refuse to link a counter to another business’s store', async () => {
      await expect(
        prisma.withTenant(
          A.tenantId,
          (tx) =>
            tx.$executeRaw`INSERT INTO counters (id, tenant_id, store_id, number, name, updated_at) VALUES (gen_random_uuid(), ${A.tenantId}::uuid, ${B.storeId}::uuid, 7, 'x', now())`,
        ),
      ).rejects.toThrow(/foreign key/i);
    });

    it('the API connects as a role that cannot bypass RLS', async () => {
      const r = await prisma.$queryRaw<
        { rolsuper: boolean; rolbypassrls: boolean }[]
      >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(r[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });

  /* ------------------------------------------------------------------ */
  describe('branches, counters and devices', () => {
    let tnagar: string;

    it('creates branches under the same PAN; enforces GSTIN rules and unique codes', async () => {
      const t = as(A.token);
      const addr = {
        line1: '48, Usman Road',
        city: 'Chennai',
        pincode: '600017',
        stateCode: '33',
      };
      const ok = await t
        .post('/api/v1/stores', {
          code: 'tng',
          name: 'T. Nagar',
          address: addr,
          gstin: gstin('33', A.pan),
          monthlyTarget: 3000000,
        })
        .expect(201);
      expect(ok.body).toMatchObject({
        code: 'TNG',
        isHq: false,
        monthlyTarget: '3000000.00',
      });
      tnagar = ok.body.id;

      const kar = await t.post('/api/v1/stores', {
        code: 'KOR',
        name: 'Koramangala',
        address: {
          line1: '80 Feet Road',
          city: 'Bengaluru',
          pincode: '560034',
          stateCode: '29',
        },
        gstin: gstin('29', A.pan),
      });
      expect(kar.status).toBe(201);

      const wrongPan = await t.post('/api/v1/stores', {
        code: 'X1',
        name: 'x',
        address: addr,
        gstin: gstin('33', randomPan()),
      });
      expect(wrongPan.status).toBe(422);
      expect(wrongPan.body.error.message).toMatch(/PAN/);
      const wrongState = await t.post('/api/v1/stores', {
        code: 'X2',
        name: 'x',
        address: addr,
        gstin: gstin('29', A.pan),
      });
      expect(wrongState.body.error.message).toMatch(/state/);
      const dup = await t.post('/api/v1/stores', {
        code: 'TNG',
        name: 'x',
        address: addr,
        gstin: gstin('33', A.pan),
      });
      expect(dup.status).toBe(409);
      const badCode = await t.post('/api/v1/stores', {
        code: 'TOOLONG',
        name: 'x',
        address: addr,
        gstin: gstin('33', A.pan),
      });
      expect(badCode.status).toBe(400);
    });

    it('numbers counters 1–9, refuses a 10th and refuses counters in warehouses', async () => {
      const t = as(A.token);
      for (let n = 2; n <= 9; n++) {
        const c = await t
          .post(`/api/v1/stores/${tnagar}/counters`, { name: `Till ${n}` })
          .expect(201);
        expect(c.body.number).toBe(n - 1); // a new branch starts with no counters
      }
      const list = await t.get(`/api/v1/stores/${tnagar}/counters`).expect(200);
      expect(list.body.data.map((c: { number: number }) => c.number)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
      await t
        .post(`/api/v1/stores/${tnagar}/counters`, { name: 'Ninth' })
        .expect(201);
      const tenth = await t.post(`/api/v1/stores/${tnagar}/counters`, {
        name: 'Tenth',
      });
      expect(tenth.body.error.code).toBe('COUNTER_LIMIT');

      const wh = await t
        .post('/api/v1/stores', {
          code: 'WH1',
          name: 'Central Warehouse',
          kind: 'WAREHOUSE',
          address: {
            line1: 'SIDCO',
            city: 'Chennai',
            pincode: '600098',
            stateCode: '33',
          },
          gstin: gstin('33', A.pan),
        })
        .expect(201);
      const whCounter = await t.post(`/api/v1/stores/${wh.body.id}/counters`, {
        name: 'x',
      });
      expect(whCounter.body.error.code).toBe('NOT_A_STORE');
    });

    it('registers a device: key shown once, stored only as a hash, revocable', async () => {
      const t = as(A.token);
      const res = await t
        .post(`/api/v1/counters/${A.counterId}/devices`, {
          name: 'Front till PC',
        })
        .expect(201);
      const { device, deviceKey } = res.body;
      expect(deviceKey).toMatch(
        new RegExp(`^${A.tenantId}\\.${device.id}\\.[A-Za-z0-9_-]{43}$`),
      );
      const row = await prisma.withTenant(A.tenantId, (tx) =>
        tx.terminalDevice.findUniqueOrThrow({ where: { id: device.id } }),
      );
      expect(row.keyHash).toBe(
        createHash('sha256').update(deviceKey).digest('hex'),
      );

      const list = await t
        .get(`/api/v1/stores/${A.storeId}/devices`)
        .expect(200);
      expect(JSON.stringify(list.body)).not.toMatch(/keyHash|deviceKey/);
      const revoked = await t
        .post(`/api/v1/devices/${device.id}/revoke`)
        .expect(201);
      expect(revoked.body.status).toBe('REVOKED');
    });

    it('closing a branch disables its counters and revokes devices; HQ cannot be closed', async () => {
      const t = as(A.token);
      await t
        .post(
          `/api/v1/counters/${(await t.get(`/api/v1/stores/${tnagar}/counters`)).body.data[0].id}/devices`,
          { name: 'TNG PC' },
        )
        .expect(201);
      const closed = await t.post(`/api/v1/stores/${tnagar}/close`).expect(201);
      expect(closed.body.status).toBe('CLOSED');
      const counters = await t
        .get(`/api/v1/stores/${tnagar}/counters`)
        .expect(200);
      expect(
        counters.body.data.every(
          (c: { status: string }) => c.status === 'DISABLED',
        ),
      ).toBe(true);
      const devices = await t
        .get(`/api/v1/stores/${tnagar}/devices`)
        .expect(200);
      expect(
        devices.body.data.every(
          (d: { status: string }) => d.status === 'REVOKED',
        ),
      ).toBe(true);
      const hq = await t.post(`/api/v1/stores/${A.storeId}/close`);
      expect(hq.body.error.code).toBe('HQ_NOT_CLOSABLE');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('branch-level authorization and staff management', () => {
    let branch: string; // Velachery, assigned to the manager
    let manager: { id: string; userId: string; email: string };
    let managerToken: string;
    let cashierToken: string;

    beforeAll(async () => {
      const t = as(A.token);
      branch = (
        await t
          .post('/api/v1/stores', {
            code: 'VEL',
            name: 'Velachery',
            address: {
              line1: '100 Feet Road',
              city: 'Chennai',
              pincode: '600042',
              stateCode: '33',
            },
            gstin: gstin('33', A.pan),
          })
          .expect(201)
      ).body.id;
      const m = await t
        .post('/api/v1/memberships', {
          name: 'Revathi',
          email: `mgr-${randomUUID()}@example.test`,
          password: 'correct-horse-battery',
          roleKeys: ['branch_manager'],
          storeIds: [branch],
        })
        .expect(201);
      manager = m.body;
      managerToken = await tokenFor(manager, A.tenantId);
      const c = await t
        .post('/api/v1/memberships', {
          name: 'Kumar',
          email: `csh-${randomUUID()}@example.test`,
          password: 'correct-horse-battery',
          roleKeys: ['cashier'],
          storeIds: [branch],
          pin: '4321',
        })
        .expect(201);
      expect(c.body).toMatchObject({
        roles: ['cashier'],
        storeIds: [branch],
        hasPin: true,
      });
      cashierToken = await tokenFor(c.body, A.tenantId);
    });

    it('a branch manager sees and manages only their branch', async () => {
      const t = as(managerToken);
      const stores = await t.get('/api/v1/stores').expect(200);
      expect(stores.body.data.map((s: { id: string }) => s.id)).toEqual([
        branch,
      ]);
      await t.get(`/api/v1/stores/${A.storeId}`).expect(404);
      await t
        .post(`/api/v1/stores/${branch}/counters`, { name: 'Express' })
        .expect(201);
      await t
        .post(`/api/v1/stores/${A.storeId}/counters`, { name: 'x' })
        .expect(404);
      const create = await t.post('/api/v1/stores', {
        code: 'NEW',
        name: 'x',
        address: { line1: 'x', city: 'x', pincode: '600001', stateCode: '33' },
        gstin: gstin('33', A.pan),
      });
      expect(create.status).toBe(403);
    });

    it('a branch manager may add cashiers to their branch — nothing else', async () => {
      const t = as(managerToken);
      const person = () => ({
        name: 'N',
        email: `n-${randomUUID()}@example.test`,
        password: 'correct-horse-battery',
      });
      await t
        .post('/api/v1/memberships', {
          ...person(),
          roleKeys: ['cashier'],
          storeIds: [branch],
        })
        .expect(201);
      expect(
        (
          await t.post('/api/v1/memberships', {
            ...person(),
            roleKeys: ['inventory_manager'],
            storeIds: [branch],
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await t.post('/api/v1/memberships', {
            ...person(),
            roleKeys: ['cashier'],
            storeIds: [A.storeId],
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await t.post('/api/v1/memberships', {
            ...person(),
            roleKeys: ['owner'],
          })
        ).status,
      ).toBe(403);
      // The owner isn't in the manager's branch → invisible.
      const ownerMembership = await prisma.membership.findFirstOrThrow({
        where: { tenantId: A.tenantId, userId: A.userId },
      });
      await t
        .patch(`/api/v1/memberships/${ownerMembership.id}`, {
          status: 'DISABLED',
        })
        .expect(404);
      const list = await t.get('/api/v1/memberships').expect(200);
      expect(
        list.body.data.every((m: { storeIds: string[] | null }) =>
          m.storeIds?.includes(branch),
        ),
      ).toBe(true);
    });

    it('a cashier cannot manage staff, counters or branches', async () => {
      const t = as(cashierToken);
      await t.get('/api/v1/memberships').expect(403);
      await t
        .post(`/api/v1/stores/${branch}/counters`, { name: 'x' })
        .expect(403);
      await t.patch(`/api/v1/stores/${branch}`, { name: 'x' }).expect(403);
      await t
        .patch('/api/v1/tenants/current', { displayName: 'x' })
        .expect(403);
      const stores = await t.get('/api/v1/stores').expect(200);
      expect(stores.body.data.map((s: { id: string }) => s.id)).toEqual([
        branch,
      ]);
    });

    it('the type of business is set at setup and can’t be changed', async () => {
      const cur = (await as(A.token).get('/api/v1/tenants/current').expect(200)).body;
      const other = cur.businessType === 'pharmacy' ? 'grocery' : 'pharmacy';
      const res = await as(A.token).patch('/api/v1/tenants/current', { businessType: other }).expect(409);
      expect(res.body.error.code).toBe('BUSINESS_TYPE_LOCKED');
      // Sending the same type (a full-profile save) is fine.
      await as(A.token).patch('/api/v1/tenants/current', { businessType: cur.businessType }).expect(200);
      expect((await as(A.token).get('/api/v1/tenants/current').expect(200)).body.businessType).toBe(cur.businessType);
    });

    it('disabling a member takes effect on their very next request', async () => {
      await as(managerToken).get('/api/v1/stores').expect(200);
      await as(A.token)
        .patch(`/api/v1/memberships/${manager.id}`, { status: 'DISABLED' })
        .expect(200);
      await as(managerToken).get('/api/v1/stores').expect(401);
      await as(A.token)
        .patch(`/api/v1/memberships/${manager.id}`, { status: 'ACTIVE' })
        .expect(200);
      await as(managerToken).get('/api/v1/stores').expect(200);
    });

    it('protects owners: no self-changes, admins cannot touch owners, last owner stays', async () => {
      const ownerMembership = await prisma.membership.findFirstOrThrow({
        where: { tenantId: A.tenantId, userId: A.userId },
      });
      const self = await as(A.token).patch(
        `/api/v1/memberships/${ownerMembership.id}`,
        { roleKeys: ['cashier'], storeIds: [branch] },
      );
      expect(self.body.error.code).toBe('SELF_CHANGE');

      const admin = await as(A.token)
        .post('/api/v1/memberships', {
          name: 'Admin',
          email: `adm-${randomUUID()}@example.test`,
          password: 'correct-horse-battery',
          roleKeys: ['business_admin'],
        })
        .expect(201);
      expect(admin.body.storeIds).toBeNull();
      const adminToken = await tokenFor(admin.body, A.tenantId);
      expect(
        (
          await as(adminToken).patch(
            `/api/v1/memberships/${ownerMembership.id}`,
            { status: 'DISABLED' },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await as(adminToken).post('/api/v1/memberships', {
            name: 'O2',
            email: `o2-${randomUUID()}@example.test`,
            password: 'correct-horse-battery',
            roleKeys: ['owner'],
          })
        ).status,
      ).toBe(403);

      // A second owner may demote the first only while another active owner remains.
      const o2 = await as(A.token)
        .post('/api/v1/memberships', {
          name: 'Co-owner',
          email: `co-${randomUUID()}@example.test`,
          password: 'correct-horse-battery',
          roleKeys: ['owner'],
        })
        .expect(201);
      const o2Token = await tokenFor(o2.body, A.tenantId);
      await as(o2Token)
        .patch(`/api/v1/memberships/${ownerMembership.id}`, {
          roleKeys: ['business_admin'],
        })
        .expect(200);
      const last = await as(A.token).patch(
        `/api/v1/memberships/${o2.body.id}`,
        { status: 'DISABLED' },
      );
      expect(last.status).toBe(403); // A is now an admin — can't touch an owner
      await as(o2Token)
        .patch(`/api/v1/memberships/${ownerMembership.id}`, {
          roleKeys: ['owner'],
        })
        .expect(200);
    });

    it('one person can belong to two businesses with one account', async () => {
      const before = await prisma.user.count();
      const res = await as(B.token)
        .post('/api/v1/memberships', {
          name: 'ignored',
          email: A.email,
          roleKeys: ['cashier'],
          storeIds: [B.storeId],
        })
        .expect(201);
      expect(res.body.userId).toBe(A.userId);
      expect(await prisma.user.count()).toBe(before);
      const u = await prisma.user.findUniqueOrThrow({
        where: { id: A.userId },
      });
      expect(u.name).toBe('Alpha Mart Owner'); // existing account untouched
      // Same person, but tokens stay per business: A's token still only sees A.
      const s = await as(A.token).get('/api/v1/stores').expect(200);
      expect(s.body.data.map((x: { id: string }) => x.id)).not.toContain(
        B.storeId,
      );
    });
  });

  it('documents the new endpoints in OpenAPI', async () => {
    const res = await http().get('/api/docs-json').expect(200);
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/tenants',
        '/api/v1/tenants/current',
        '/api/v1/stores',
        '/api/v1/stores/{storeId}/counters',
        '/api/v1/counters/{counterId}/devices',
        '/api/v1/memberships',
        '/api/v1/roles',
      ]),
    );
    expect(res.body.paths['/api/v1/tenants'].post.requestBody).toBeDefined();
  });
});
