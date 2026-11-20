# Phase 3 — Authentication and authorization

**Exit criterion:** *Protected routes reject unauthenticated users, and every role is restricted to
its approved actions and branches.* — met; evidence in `test/auth.e2e-spec.ts` (authorization
matrix: 5 roles × 7 sensitive endpoints, plus 401 without a token) and `test/tenancy.e2e-spec.ts`.

## Endpoints (`/api/v1/auth`)

| Endpoint | Purpose |
| --- | --- |
| `POST /login` | Email + password. Returns `AUTHENTICATED` + tokens, or `SELECT_TENANT` with the businesses to choose from (repeat with `tenantId`). |
| `POST /refresh` | One-time refresh token → new pair. |
| `POST /logout` | Ends this session (works with an expired access token). |
| `POST /logout-all` | Ends every session of the user, all businesses. |
| `GET /me` | User, business, roles, permissions, branches, session (and device for PIN sessions). |
| `POST /switch-tenant` | Session for another business the person belongs to. |
| `GET /sessions`, `DELETE /sessions/:id` | See and end your own sessions. |
| `POST /change-password` | Needs the current password; ends the other sessions. |
| `POST /forgot-password`, `POST /reset-password` | Emailed single-use link, 30 minutes. |
| `GET /device/cashiers`, `POST /pin-login` | Counter sign-in with a cashier PIN on a registered device (`X-Device-Key`). |
| `POST /tenants/additional` | A signed-in person opens another business. |

## Tokens and sessions (ADR-005)

* **Access token:** JWT HS256, 15 minutes, claims `sub tid mid sid`. Every request re-checks the
  session, membership, user and business in the database, so logout, disabling a member, revoking
  a device or closing a counter take effect on the **next request**.
* **Refresh token:** opaque `<sessionId>.<256-bit secret>`, stored as SHA-256. Password sessions:
  14 days sliding, 30 days maximum. PIN sessions: 12 hours sliding, 16 hours maximum (one shift).
* **Rotation with reuse detection:** each refresh token works once. Presenting a used one revokes
  the whole session family (audit `auth.refresh_reuse_detected`). Concurrent refreshes with the
  same token: exactly one succeeds (conditional update).
* **Where the refresh token lives:** browsers — `rt` cookie, `HttpOnly; SameSite=Strict;
  Secure (production); Path=/api/v1/auth`, never in the response body; cookie calls must come from
  an allowed origin. Native clients (Electron POS, mobile) send `X-Client: native` and get it in the
  body.

## Account protection

| Control | Setting |
| --- | --- |
| Password hashing | Argon2id; hashes with outdated cost settings are upgraded at next sign-in |
| Password rules | 10–128 characters, must not contain the email name |
| Account lockout | 5 wrong passwords → locked 15 minutes (the right password is refused while locked) |
| PIN lockout | 5 wrong PINs → that PIN locked 15 minutes |
| Rate limits (per IP, per endpoint) | 300/min general; 10/min on login, refresh, PIN, forgot/reset password, registration (`RATE_LIMIT_PER_MINUTE`, `AUTH_RATE_LIMIT_PER_MINUTE`); health probes exempt |
| Enumeration | Unknown email and wrong password give the same answer and take the same time; forgot-password always answers 202 |
| Behind a proxy | `TRUST_PROXY=true` so limits and audit use the real client IP |

Known trade-off: a locked account answers `ACCOUNT_LOCKED`, which reveals that the email exists
to someone who already made 5 attempts on it; the per-IP limit keeps that slow.

## PIN sign-in on a counter

1. A manager registers the computer (`POST /counters/:id/devices`) and stores the returned
   `deviceKey` (`<tenantId>.<deviceId>.<secret>`) on it.
2. The sign-in screen lists billers of that branch who have a PIN (`GET /device/cashiers`).
3. `POST /pin-login` → a PIN session bound to the device: branch access is limited to the
   device's branch, it can't switch business, and it ends if the device is revoked or the counter
   or branch is disabled.
4. **One counter at a time:** a cashier's PIN sign-in ends their PIN sessions on every other
   computer in the business (`revoked_reason = PIN_ELSEWHERE`); that computer is signed out on its
   next request. Password sessions are not affected.

## Audit events

`auth.login_succeeded`, `auth.login_failed`, `auth.login_blocked`, `auth.account_locked`,
`auth.logout`, `auth.logout_all`, `auth.session_revoked`, `auth.refresh_reuse_detected`,
`auth.tenant_switched`, `auth.password_changed`, `auth.password_change_failed`,
`auth.password_reset_requested`, `auth.password_reset`, `auth.pin_login`, `auth.pin_failed`,
`auth.pin_locked`.

## Not in this phase

* **Email delivery** — reset emails go to the development outbox/log until Phase 11 adds a
  provider; in production nothing is sent (and nothing sensitive is logged).
* **Email/mobile verification and MFA** — the plan lists them as "as required" / later.
* **Rate-limit storage** is in memory (one API instance). Move it to Redis before running several
  instances.
