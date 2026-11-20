import { createHmac, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createTestApp } from './utils.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { MailerService } from '../src/mail/mailer.service.js';
import { gstinCheckChar } from '../src/common/gst.js';

const PASSWORD = 'correct-horse-battery';
const gstin = (state: string, pan: string) => {
  const f = `${state}${pan}1Z`;
  return f + gstinCheckChar(f);
};
const randomPan = () => {
  const L = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  return `${L()}${L()}${L()}P${L()}${String(1000 + Math.floor(Math.random() * 9000))}${L()}`;
};
const sidOf = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString())
    .sid as string;

describe('Phase 3 — authentication and authorization (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let mailer: MailerService;
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const native = { 'X-Client': 'native' };

  type Biz = {
    tenantId: string;
    storeId: string;
    counterId: string;
    email: string;
    token: string;
    pan: string;
  };

  async function register(name: string): Promise<Biz> {
    const pan = randomPan();
    const email = `own-${randomUUID()}@example.test`;
    const res = await http()
      .post('/api/v1/tenants')
      .set(native)
      .send({
        business: {
          displayName: name,
          businessType: 'supermarket',
          registration: 'REGULAR',
          gstin: gstin('33', pan),
          stateCode: '33',
          address: { line1: '1 Main Road', city: 'Chennai', pincode: '600001' },
        },
        owner: { name: `${name} Owner`, email, password: PASSWORD },
        hq: { code: 'HQ' },
      })
      .expect(201);
    return {
      tenantId: res.body.tenant.id,
      storeId: res.body.store.id,
      counterId: res.body.counter.id,
      email,
      token: res.body.accessToken,
      pan,
    };
  }

  const login = (email: string, extra: object = {}, password = PASSWORD) =>
    http()
      .post('/api/v1/auth/login')
      .set(native)
      .send({ email, password, ...extra });

  async function addMember(
    owner: Biz,
    roleKeys: string[],
    storeIds: string[],
    pin?: string,
  ) {
    const email = `m-${randomUUID()}@example.test`;
    const res = await http()
      .post('/api/v1/memberships')
      .set(bearer(owner.token))
      .send({
        name: `${roleKeys[0]} ${email.slice(2, 6)}`,
        email,
        password: PASSWORD,
        roleKeys,
        storeIds,
        ...(pin ? { pin } : {}),
      })
      .expect(201);
    return { id: res.body.id as string, email };
  }

  let A: Biz;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    mailer = app.get(MailerService);
    A = await register('Auth Mart');
  });
  afterAll(async () => {
    await app.close();
  });

  /* ------------------------------------------------------------------ */
  describe('password sign-in', () => {
    it('browser sign-in: refresh token only in an httpOnly, SameSite=Strict cookie', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: A.email, password: PASSWORD })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'AUTHENTICATED',
        tokenType: 'Bearer',
        expiresIn: 900,
        tenant: { id: A.tenantId },
      });
      expect(res.body.refreshToken).toBeUndefined();
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/^rt=[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}; /);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/SameSite=Strict/);
      expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

      const me = await http()
        .get('/api/v1/auth/me')
        .set(bearer(res.body.accessToken))
        .expect(200);
      expect(me.body).toMatchObject({
        tenant: { id: A.tenantId },
        membership: { roles: ['owner'], storeIds: null },
        session: { kind: 'PASSWORD' },
      });
      expect(me.body.membership.permissions).toContain('users:manage');
    });

    it('native sign-in: refresh token in the body, no cookie', async () => {
      const res = await login(A.email).expect(200);
      expect(res.body.refreshToken).toMatch(
        /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/,
      );
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('wrong password and unknown email are indistinguishable', async () => {
      const wrong = await login(A.email, {}, 'wrong-password-123').expect(401);
      const unknown = await login(`nobody-${randomUUID()}@example.test`).expect(
        401,
      );
      expect(wrong.body.error).toEqual({
        ...unknown.body.error,
        requestId: wrong.body.error.requestId,
      });
      expect(wrong.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is incorrect.',
      });
    });

    it('locks the account for 15 minutes after 5 wrong passwords — even the right one is refused', async () => {
      const victim = await register('Lock Mart');
      for (let i = 0; i < 5; i++)
        await login(victim.email, {}, `wrong-${i}-password`).expect(401);
      const blocked = await login(victim.email).expect(429);
      expect(blocked.body.error.code).toBe('ACCOUNT_LOCKED');
      expect(blocked.body.error.message).toMatch(/15 minutes/);
      const audit = await prisma.auditLog.findMany({
        where: {
          action: 'auth.account_locked',
          actorUserId: (
            await prisma.user.findUniqueOrThrow({
              where: { email: victim.email },
            })
          ).id,
        },
      });
      expect(audit).toHaveLength(1);

      // When the lock lapses, the right password works and the counter starts again.
      await prisma.user.update({
        where: { email: victim.email },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      await login(victim.email).expect(200);
      expect(
        (
          await prisma.user.findUniqueOrThrow({
            where: { email: victim.email },
          })
        ).failedLogins,
      ).toBe(0);
    });

    it('people in several businesses choose one; switch-tenant moves between them', async () => {
      const multi = await register('Multi One');
      const second = await http()
        .post('/api/v1/tenants/additional')
        .set(bearer(multi.token))
        .set(native)
        .send({
          business: {
            displayName: 'Multi Two',
            businessType: 'pharmacy',
            registration: 'UNREGISTERED',
            stateCode: '29',
            address: { line1: '2 Road', city: 'Bengaluru', pincode: '560001' },
          },
          hq: { code: 'BLR' },
        })
        .expect(201);
      expect(second.body.store).toMatchObject({ code: 'BLR', isHq: true });
      const t2 = second.body.tenant.id as string;

      const choose = await login(multi.email).expect(200);
      expect(choose.body.status).toBe('SELECT_TENANT');
      expect(
        choose.body.tenants
          .map((t: { displayName: string }) => t.displayName)
          .sort(),
      ).toEqual(['Multi One', 'Multi Two']);
      expect(choose.body.accessToken).toBeUndefined();

      const into2 = await login(multi.email, { tenantId: t2 }).expect(200);
      const stores2 = await http()
        .get('/api/v1/stores')
        .set(bearer(into2.body.accessToken))
        .expect(200);
      expect(stores2.body.data.map((s: { code: string }) => s.code)).toEqual([
        'BLR',
      ]);

      const back = await http()
        .post('/api/v1/auth/switch-tenant')
        .set(bearer(into2.body.accessToken))
        .set(native)
        .send({ tenantId: multi.tenantId })
        .expect(200);
      const stores1 = await http()
        .get('/api/v1/stores')
        .set(bearer(back.body.accessToken))
        .expect(200);
      expect(stores1.body.data.map((s: { code: string }) => s.code)).toEqual([
        'HQ',
      ]);
      // Not a member of A → can't switch there.
      await http()
        .post('/api/v1/auth/switch-tenant')
        .set(bearer(back.body.accessToken))
        .send({ tenantId: A.tenantId })
        .expect(404);
      // Choosing a business you don't belong to is just a failed login.
      await login(multi.email, { tenantId: A.tenantId }).expect(401);
    });

    it('a disabled member cannot sign in to that business', async () => {
      const m = await addMember(A, ['cashier'], [A.storeId]);
      await http()
        .patch(`/api/v1/memberships/${m.id}`)
        .set(bearer(A.token))
        .send({ status: 'DISABLED' })
        .expect(200);
      const res = await login(m.email).expect(403);
      expect(res.body.error.code).toBe('NO_ACTIVE_BUSINESS');
    });
  });

  /* ------------------------------------------------------------------ */
  describe('sessions: rotation, reuse detection, logout', () => {
    it('rotates refresh tokens; re-using an old one signs out the whole family', async () => {
      const first = (await login(A.email).expect(200)).body;
      const second = (
        await http()
          .post('/api/v1/auth/refresh')
          .set(native)
          .send({ refreshToken: first.refreshToken })
          .expect(200)
      ).body;
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.accessToken).not.toBe(first.accessToken);
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(second.accessToken))
        .expect(200);

      // An attacker (or a confused tab) replays the first token.
      const replay = await http()
        .post('/api/v1/auth/refresh')
        .set(native)
        .send({ refreshToken: first.refreshToken })
        .expect(401);
      expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
      // The legitimate newest token and its access token are now dead too.
      await http()
        .post('/api/v1/auth/refresh')
        .set(native)
        .send({ refreshToken: second.refreshToken })
        .expect(401);
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(second.accessToken))
        .expect(401);
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'auth.refresh_reuse_detected',
            entityId: (
              await prisma.session.findUniqueOrThrow({
                where: { id: sidOf(first.accessToken) },
              })
            ).familyId,
          },
        }),
      ).toBe(1);
    });

    it('two simultaneous refreshes with one token: exactly one wins', async () => {
      const first = (await login(A.email).expect(200)).body;
      const [a, b] = await Promise.all([
        http()
          .post('/api/v1/auth/refresh')
          .set(native)
          .send({ refreshToken: first.refreshToken }),
        http()
          .post('/api/v1/auth/refresh')
          .set(native)
          .send({ refreshToken: first.refreshToken }),
      ]);
      expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 401]);
    });

    it('cookie refresh works from the app origin and is refused from another origin', async () => {
      const res = await http()
        .post('/api/v1/auth/login')
        .send({ email: A.email, password: PASSWORD })
        .expect(200);
      const cookie = String(res.headers['set-cookie']).split(';')[0]!;
      const ok = await http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .set('Origin', 'http://localhost:3000')
        .expect(200);
      expect(ok.body.refreshToken).toBeUndefined();
      const rotated = String(ok.headers['set-cookie']).split(';')[0]!;
      expect(rotated).not.toBe(cookie);
      const evil = await http()
        .post('/api/v1/auth/refresh')
        .set('Cookie', rotated)
        .set('Origin', 'http://evil.test')
        .expect(403);
      expect(evil.body.error.code).toBe('FORBIDDEN_ORIGIN');
    });

    it('logout ends the session immediately — access token included', async () => {
      const s = (await login(A.email).expect(200)).body;
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(s.accessToken))
        .expect(200);
      await http()
        .post('/api/v1/auth/logout')
        .set(native)
        .send({ refreshToken: s.refreshToken })
        .expect(204);
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(s.accessToken))
        .expect(401);
      await http()
        .post('/api/v1/auth/refresh')
        .set(native)
        .send({ refreshToken: s.refreshToken })
        .expect(401);
      // Logging out twice, or with garbage, is harmless.
      await http()
        .post('/api/v1/auth/logout')
        .set(native)
        .send({ refreshToken: s.refreshToken })
        .expect(204);
      await http().post('/api/v1/auth/logout').send({}).expect(204);
    });

    it('lists your sessions; you can end one, or all of them', async () => {
      const u = await register('Session Mart');
      const a = (await login(u.email).expect(200)).body;
      const b = (await login(u.email).expect(200)).body;
      const list = await http()
        .get('/api/v1/auth/sessions')
        .set(bearer(a.accessToken))
        .expect(200);
      const mine = list.body.data.find((x: { current: boolean }) => x.current);
      expect(list.body.data.length).toBeGreaterThanOrEqual(3); // registration + two logins
      const other = (
        await prisma.session.findUniqueOrThrow({
          where: { id: sidOf(b.accessToken) },
        })
      ).familyId;
      expect(mine.id).not.toBe(other);

      await http()
        .delete(`/api/v1/auth/sessions/${other}`)
        .set(bearer(a.accessToken))
        .expect(204);
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(b.accessToken))
        .expect(401);
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(a.accessToken))
        .expect(200);
      // Someone else's session id → 404.
      const foreign = (
        await prisma.session.findUniqueOrThrow({
          where: { id: sidOf(A.token) },
        })
      ).familyId;
      await http()
        .delete(`/api/v1/auth/sessions/${foreign}`)
        .set(bearer(a.accessToken))
        .expect(404);

      await http()
        .post('/api/v1/auth/logout-all')
        .set(bearer(a.accessToken))
        .expect(204);
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(a.accessToken))
        .expect(401);
      await http().get('/api/v1/auth/me').set(bearer(u.token)).expect(401);
    });

    it('rejects expired, unsigned and foreign-signed access tokens', async () => {
      const jwt = app.get(JwtService);
      const p = JSON.parse(
        Buffer.from(A.token.split('.')[1]!, 'base64url').toString(),
      );
      const claims = { sub: p.sub, tid: p.tid, mid: p.mid, sid: p.sid };
      const expired = jwt.sign({
        ...claims,
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      const r1 = await http()
        .get('/api/v1/auth/me')
        .set(bearer(expired))
        .expect(401);
      expect(r1.body.error.code).toBe('TOKEN_EXPIRED');

      const b64 = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims, iss: 'billing-api', exp: p.exp })}.`;
      await http().get('/api/v1/auth/me').set(bearer(none)).expect(401);

      const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, iss: 'billing-api', exp: p.exp })}`;
      const forged = `${body}.${createHmac('sha256', 'guessed-secret').update(body).digest('base64url')}`;
      await http().get('/api/v1/auth/me').set(bearer(forged)).expect(401);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('passwords', () => {
    it('forgot-password answers identically for unknown emails and sends nothing', async () => {
      const before = mailer.outbox.length;
      const res = await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: `ghost-${randomUUID()}@example.test` })
        .expect(202);
      expect(res.body.message).toMatch(/If an account exists/);
      expect(mailer.outbox.length).toBe(before);
    });

    it('reset link: single use, newest only, unlocks, and signs out every session', async () => {
      const u = await register('Reset Mart');
      const live = (await login(u.email).expect(200)).body;
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: u.email.toUpperCase() })
        .expect(202);
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: u.email })
        .expect(202);
      const mails = mailer.outbox.filter((m) => m.to === u.email);
      expect(mails).toHaveLength(2);
      const tokenOf = (text: string) =>
        decodeURIComponent(/reset-password\?token=([^\s]+)/.exec(text)![1]!);
      const [older, newer] = mails.map((m) => tokenOf(m.text));
      expect(mails[1]!.text).toContain(
        'http://localhost:3000/reset-password?token=',
      );

      // Lock the account, then reset — reset should also unlock it.
      await prisma.user.update({
        where: { email: u.email },
        data: { lockedUntil: new Date(Date.now() + 600_000) },
      });
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: older, newPassword: 'brand-new-password-1' })
        .expect(400);
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: newer, newPassword: 'brand-new-password-1' })
        .expect(204);
      await http()
        .post('/api/v1/auth/reset-password')
        .send({ token: newer, newPassword: 'another-password-2' })
        .expect(400);

      await http()
        .get('/api/v1/auth/me')
        .set(bearer(live.accessToken))
        .expect(401);
      await http().get('/api/v1/auth/me').set(bearer(u.token)).expect(401);
      await login(u.email).expect(401);
      await login(u.email, {}, 'brand-new-password-1').expect(200);
    });

    it('expired reset links are refused', async () => {
      const u = await register('Expiry Mart');
      await http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: u.email })
        .expect(202);
      const mail = mailer.outbox.filter((m) => m.to === u.email).at(-1)!;
      const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.text)![1]!);
      const user = await prisma.user.findUniqueOrThrow({
        where: { email: u.email },
      });
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await http()
        .post('/api/v1/auth/reset-password')
        .send({ token, newPassword: 'brand-new-password-1' })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_RESET_TOKEN');
    });

    it('change password: needs the current one, refuses weak ones, keeps only this session', async () => {
      const u = await register('Change Mart');
      const here = (await login(u.email).expect(200)).body;
      const elsewhere = (await login(u.email).expect(200)).body;
      await http()
        .post('/api/v1/auth/change-password')
        .set(bearer(here.accessToken))
        .send({
          currentPassword: 'nope-nope-nope',
          newPassword: 'brand-new-password-1',
        })
        .expect(401);
      const local = u.email.split('@')[0]!;
      const weak = await http()
        .post('/api/v1/auth/change-password')
        .set(bearer(here.accessToken))
        .send({ currentPassword: PASSWORD, newPassword: `${local}123` })
        .expect(422);
      expect(weak.body.error.code).toBe('WEAK_PASSWORD');
      await http()
        .post('/api/v1/auth/change-password')
        .set(bearer(here.accessToken))
        .send({
          currentPassword: PASSWORD,
          newPassword: 'brand-new-password-1',
        })
        .expect(204);
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(here.accessToken))
        .expect(200);
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(elsewhere.accessToken))
        .expect(401);
      await login(u.email, {}, 'brand-new-password-1').expect(200);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('cashier PIN sign-in on a registered device', () => {
    let deviceKey: string;
    let deviceId: string;
    let cashier: { id: string; email: string };
    let otherBranchCashier: { id: string; email: string };
    let branch: string;

    beforeAll(async () => {
      const dev = await http()
        .post(`/api/v1/counters/${A.counterId}/devices`)
        .set(bearer(A.token))
        .send({ name: 'Till 1' })
        .expect(201);
      deviceKey = dev.body.deviceKey;
      deviceId = dev.body.device.id;
      branch = (
        await http()
          .post('/api/v1/stores')
          .set(bearer(A.token))
          .send({
            code: 'PIN',
            name: 'Pin Branch',
            address: {
              line1: 'x',
              city: 'Chennai',
              pincode: '600002',
              stateCode: '33',
            },
            gstin: gstin('33', A.pan),
          })
          .expect(201)
      ).body.id;
      cashier = await addMember(A, ['cashier'], [A.storeId], '4321');
      otherBranchCashier = await addMember(A, ['cashier'], [branch], '5555');
      await addMember(A, ['cashier'], [A.storeId]); // no PIN → not listed
      await addMember(A, ['inventory_manager'], [A.storeId], '9999'); // can't bill → not listed
    });

    const pin = (membershipId: string, p: string, key = deviceKey) =>
      http()
        .post('/api/v1/auth/pin-login')
        .set('X-Device-Key', key)
        .set(native)
        .send({ membershipId, pin: p });

    it("shows only this branch's PIN-enabled billers", async () => {
      await http().get('/api/v1/auth/device/cashiers').expect(401);
      const res = await http()
        .get('/api/v1/auth/device/cashiers')
        .set('X-Device-Key', deviceKey)
        .expect(200);
      expect(res.body.counter).toMatchObject({ number: 1 });
      expect(
        res.body.cashiers.map((c: { membershipId: string }) => c.membershipId),
      ).toEqual([cashier.id]);
    });

    it('signs a cashier in for one shift, limited to the device branch', async () => {
      await pin(cashier.id, '0000').expect(401);
      const res = await pin(cashier.id, '4321').expect(200);
      expect(res.body.store.id).toBe(A.storeId);
      const me = await http()
        .get('/api/v1/auth/me')
        .set(bearer(res.body.accessToken))
        .expect(200);
      expect(me.body.session).toMatchObject({
        kind: 'PIN',
        device: { id: deviceId, counterId: A.counterId, storeId: A.storeId },
      });
      expect(me.body.membership.storeIds).toEqual([A.storeId]);
      const session = await prisma.session.findUniqueOrThrow({
        where: { id: sidOf(res.body.accessToken) },
      });
      expect(
        session.familyExpiresAt.getTime() - Date.now(),
      ).toBeLessThanOrEqual(16 * 3_600_000);

      // Counter sessions can't hop businesses or open new ones.
      await http()
        .post('/api/v1/auth/switch-tenant')
        .set(bearer(res.body.accessToken))
        .send({ tenantId: A.tenantId })
        .expect(403);
    });

    it('refuses a cashier of another branch with the same generic error', async () => {
      const res = await pin(otherBranchCashier.id, '5555').expect(401);
      expect(res.body.error.code).toBe('INVALID_PIN');
    });

    it('rejects a tampered device key', async () => {
      const tampered =
        deviceKey.slice(0, -4) + (deviceKey.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      const res = await pin(cashier.id, '4321', tampered).expect(401);
      expect(res.body.error.code).toBe('INVALID_DEVICE');
    });

    it('locks a PIN after 5 wrong tries', async () => {
      const victim = await addMember(A, ['cashier'], [A.storeId], '2468');
      for (let i = 0; i < 5; i++) await pin(victim.id, '1111').expect(401);
      const res = await pin(victim.id, '2468').expect(429);
      expect(res.body.error.code).toBe('PIN_LOCKED');
    });

    it('revoking the device ends its sessions at once', async () => {
      const s = (await pin(cashier.id, '4321').expect(200)).body;
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(s.accessToken))
        .expect(200);
      await http()
        .post(`/api/v1/devices/${deviceId}/revoke`)
        .set(bearer(A.token))
        .expect(201);
      await http()
        .get('/api/v1/auth/me')
        .set(bearer(s.accessToken))
        .expect(401);
      await http()
        .get('/api/v1/auth/device/cashiers')
        .set('X-Device-Key', deviceKey)
        .expect(401);
    });
  });

  /* ------------------------------------------------------------------ */
  describe('authorization matrix (every role × sensitive endpoint)', () => {
    type Role =
      | 'owner'
      | 'business_admin'
      | 'branch_manager'
      | 'inventory_manager'
      | 'cashier';
    const tokens = {} as Record<Role, string>;
    let vel: string;
    let velCounter: string;
    let n = 0;

    beforeAll(async () => {
      vel = (
        await http()
          .post('/api/v1/stores')
          .set(bearer(A.token))
          .send({
            code: 'VEL',
            name: 'Velachery',
            address: {
              line1: 'x',
              city: 'Chennai',
              pincode: '600042',
              stateCode: '33',
            },
            gstin: gstin('33', A.pan),
          })
          .expect(201)
      ).body.id;
      velCounter = (
        await http()
          .post(`/api/v1/stores/${vel}/counters`)
          .set(bearer(A.token))
          .send({ name: 'Main' })
          .expect(201)
      ).body.id;
      tokens.owner = A.token;
      for (const role of [
        'business_admin',
        'branch_manager',
        'inventory_manager',
        'cashier',
      ] as const) {
        const m = await addMember(
          A,
          [role],
          role === 'business_admin' ? [] : [vel],
        );
        tokens[role] = (
          await login(m.email, { tenantId: A.tenantId }).expect(200)
        ).body.accessToken;
      }
    });

    const cases: [string, (t: string) => request.Test, Record<Role, number>][] =
      [
        [
          'GET /memberships',
          (t) => http().get('/api/v1/memberships').set(bearer(t)),
          {
            owner: 200,
            business_admin: 200,
            branch_manager: 200,
            inventory_manager: 403,
            cashier: 403,
          },
        ],
        [
          'GET /roles',
          (t) => http().get('/api/v1/roles').set(bearer(t)),
          {
            owner: 200,
            business_admin: 200,
            branch_manager: 200,
            inventory_manager: 403,
            cashier: 403,
          },
        ],
        [
          'PATCH /tenants/current',
          (t) =>
            http()
              .patch('/api/v1/tenants/current')
              .set(bearer(t))
              .send({ phone: '+91 44 1111 2222' }),
          {
            owner: 200,
            business_admin: 200,
            branch_manager: 403,
            inventory_manager: 403,
            cashier: 403,
          },
        ],
        [
          'POST /stores',
          (t) =>
            http()
              .post('/api/v1/stores')
              .set(bearer(t))
              .send({
                code: `M${++n}`,
                name: 'x',
                address: {
                  line1: 'x',
                  city: 'Chennai',
                  pincode: '600003',
                  stateCode: '33',
                },
                gstin: gstin('33', A.pan),
              }),
          {
            owner: 201,
            business_admin: 201,
            branch_manager: 403,
            inventory_manager: 403,
            cashier: 403,
          },
        ],
        [
          'POST /stores/:vel/counters',
          (t) =>
            http()
              .post(`/api/v1/stores/${vel}/counters`)
              .set(bearer(t))
              .send({ name: 'x' }),
          {
            owner: 201,
            business_admin: 201,
            branch_manager: 201,
            inventory_manager: 403,
            cashier: 403,
          },
        ],
        [
          'POST /counters/:id/devices',
          (t) =>
            http()
              .post(`/api/v1/counters/${velCounter}/devices`)
              .set(bearer(t))
              .send({ name: 'x' }),
          {
            owner: 201,
            business_admin: 201,
            branch_manager: 201,
            inventory_manager: 403,
            cashier: 403,
          },
        ],
        [
          'GET /stores/:hq (not assigned)',
          (t) => http().get(`/api/v1/stores/${A.storeId}`).set(bearer(t)),
          {
            owner: 200,
            business_admin: 200,
            branch_manager: 404,
            inventory_manager: 404,
            cashier: 404,
          },
        ],
      ];

    it.each(cases)('%s', async (_label, call, expected) => {
      for (const role of Object.keys(expected) as Role[]) {
        const res = await call(tokens[role]);
        expect(res.status, `${role}: ${JSON.stringify(res.body)}`).toBe(
          expected[role],
        );
      }
      await call('not-a-token').expect(401);
    });
  });
});
