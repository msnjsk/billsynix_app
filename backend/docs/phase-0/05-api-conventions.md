# Phase 0 — API conventions

## Base and versioning

* Base path `/api/v1`; breaking changes go to `/api/v2`.
* JSON only (`application/json; charset=utf-8`), camelCase field names.
* OpenAPI document at `/api/docs` (Swagger UI) and `/api/docs-json`; frontend types are generated
  from it (`npm run api:types` in the frontend, Phase 8).

## Authentication headers

* `Authorization: Bearer <access token>` (JWT, 15 min).
* Refresh token: `httpOnly; Secure; SameSite=Strict` cookie `rt` scoped to `/api/v1/auth`
  for browsers; native/Electron clients send `{ refreshToken }` in the body instead.
* Tenant is **never** taken from the body/query: it is the `tid` claim of the access token,
  which is issued for one membership (`POST /auth/switch-tenant` re-issues for another).
* Store scope: `X-Store-Id` header selects the working branch where an endpoint needs one;
  the guard verifies the membership may use it.

## Responses

Single resource: the object itself.

```json
{ "id": "…", "name": "Anna Nagar", "code": "SFM" }
```

Collections: `data` + `meta`.

```json
{ "data": [ … ], "meta": { "page": 1, "pageSize": 50, "total": 132 } }
```

* Query `?page=1&pageSize=50` (max 200). High-volume feeds (sync, movements) use cursor
  pagination: `?cursor=<opaque>&limit=500` → `meta.nextCursor`.
* Sorting `?sort=name` / `?sort=-createdAt`. Filtering via named query params.

## Errors

```json
{
  "error": {
    "code": "STOCK_INSUFFICIENT",
    "message": "Only 3 units of Toor Dal 1kg left at T. Nagar.",
    "details": [{ "field": "lines[2].qty", "issue": "exceeds_stock" }],
    "requestId": "01J…"
  }
}
```

| HTTP | When | Example `code` |
| --- | --- | --- |
| 400 | Validation failed | `VALIDATION_FAILED` |
| 401 | No/expired token | `UNAUTHENTICATED`, `TOKEN_EXPIRED` |
| 403 | Authenticated but not allowed | `FORBIDDEN`, `STORE_NOT_ASSIGNED` |
| 404 | Not found **or belongs to another tenant** (never 403 — don't leak existence) | `NOT_FOUND` |
| 409 | State conflict | `STOCK_INSUFFICIENT`, `ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT` |
| 422 | Business rule rejected | `PRICE_ABOVE_MRP`, `INVALID_GSTIN` |
| 429 | Rate limited | `RATE_LIMITED` |
| 500 | Unexpected — no internal details | `INTERNAL` |

## Idempotency

`Idempotency-Key: <uuid>` is **required** on `POST /sales`, `POST /sales/:id/returns`,
`POST /sync/*`, payments and stock-changing POSTs. The first response (status + body) is stored for
24 h; a repeat with the same key and same body returns it; same key + different body → 409
`IDEMPOTENCY_CONFLICT`.

## Correlation

Every response carries `X-Request-Id` (accepted from the client if it's a valid id, else generated).
It appears in logs and in `error.requestId`.

## Dates, money, quantities

* Timestamps: ISO-8601 UTC (`2024-05-14T05:12:00.000Z`). Business dates (reports, invoice date):
  `YYYY-MM-DD` in the store's timezone.
* Money and quantities are **strings** in JSON (`"240.00"`, `"1.250"`) to avoid float rounding;
  the generated client parses them with a decimal helper.
* Percentages are numbers (`5`, `12.5`).

## Status codes for creation

`201` with the created resource and a `Location` header; `200` for idempotent replays
(with `Idempotent-Replayed: true`).
