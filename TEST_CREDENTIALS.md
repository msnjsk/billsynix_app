# Test Credentials for Development

This document contains the test credentials for the Billing System development environment.

## ⚠️ Important Security Note

**These are test/demo credentials only.** They should:
- ✅ Only be used in development and testing environments
- ✅ Only be used on locally running instances
- ❌ Never be committed to production systems
- ❌ Never be used with real customer data
- ❌ Never be shared beyond the development team

---

## Owner Account (Primary Test User)

### Credentials

```
Email:    owner@demo.test
Password: demo-password-123
Role:     Business Owner
Tenant:   Sri Lakshmi Supermarket (Demo)
```

### How to Use

1. Navigate to the application login page
2. Enter email: `owner@demo.test`
3. Enter password: `demo-password-123`
4. Click "Sign In"

### Permissions

As a **Business Owner**, this account has full access to:
- ✅ All products and catalogue management
- ✅ All branches and inventory
- ✅ All sales and orders
- ✅ All financial and reports
- ✅ User and staff management
- ✅ System settings and configuration
- ✅ Approval workflows with no limits

---

## Setting Up Test Data

### Automatic Seed

The backend includes a seeded demo database with test data:

```bash
# From the backend directory
npm run db:seed
# or
bun run db:seed
```

This creates:
- **Business:** Sri Lakshmi Supermarket
- **Branches:** Anna Nagar (Counter 1), T. Nagar (Counter 2)
- **Products:** 100+ sample products with categories and pricing
- **Suppliers:** 4 sample suppliers
- **Staff:** Cashiers and managers for testing

The seed is idempotent—running it multiple times updates existing data safely.

---

## Multi-Role Testing

After signing in with the owner account, you can test different roles:

### Role Switching (via Branches UI)

Navigate to `/branches` to switch between different roles and branches:

| Role | Permissions | Usage |
|------|-------------|-------|
| **Owner** | Full system access | General admin and setup |
| **Branch Manager** | Manage single branch, inventory, pricing | Branch-level operations |
| **Inventory Manager** | Manage stock and adjustments | Stock control |
| **Cashier** | Process sales only | POS operations |

---

## Backend API Testing

### Environment Setup

1. **Start the backend:**
   ```bash
   cd backend
   docker compose --profile api up
   # API runs on http://localhost:4000
   ```

2. **Configure frontend to use backend:**
   ```bash
   # Create .env.local in project root
   NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
   ```

3. **Start the frontend:**
   ```bash
   npm run dev
   # App runs on http://localhost:3000
   ```

### Direct API Testing

#### Login (Get Access Token)

```bash
curl -X POST http://localhost:4000/api/v1/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "owner@demo.test",
    "password": "demo-password-123"
  }'
```

**Response:**
```json
{
  "status": "AUTHENTICATED",
  "accessToken": "eyJhbGc...",
  "refreshToken": "eyJhbGc...",
  "user": {
    "id": "...",
    "email": "owner@demo.test",
    "name": "Demo Owner",
    "roles": ["owner"]
  }
}
```

#### Using the Token

Include the access token in subsequent requests:

```bash
curl -X GET http://localhost:4000/api/v1/products \
  -H "Authorization: Bearer <accessToken>"
```

#### Logout (Invalidate Token)

```bash
curl -X POST http://localhost:4000/api/v1/logout \
  -H "Authorization: Bearer <accessToken>"
```

---

## Demo Business Setup

### Sri Lakshmi Supermarket

**Headquarters:** Anna Nagar, Chennai

#### Branches

| Branch | Code | Location | Manager |
|--------|------|----------|---------|
| Counter 1 (HQ) | AN | Anna Nagar | Demo Owner |
| Counter 2 | TN | T. Nagar | Demo Branch Manager |

#### Sample Data

- **100+ Products** across multiple categories:
  - Grocery, Rice, Oils
  - Dairy, Beverages
  - Toiletries, Household
- **4 Suppliers** with pricing terms
- **Multiple Tax Rates** (5%, 12%, 18% GST)
- **Demo Pricing:** All set for testing discount rules, MRP checks, and calculations

---

## Testing Common Workflows

### 1. First-Time Setup Flow

```
✅ Already pre-configured with the seed
Skip /setup and go directly to login
```

### 2. Create a Sale

```
1. Login as owner@demo.test
2. Navigate to /pos
3. Add products to cart
4. Enter customer details
5. Process payment
6. Verify bill and receipt
```

### 3. Check Inventory

```
1. Login as owner@demo.test
2. Navigate to /inventory
3. View stock levels by branch
4. Create stock adjustments
```

### 4. View Reports

```
1. Login as owner@demo.test
2. Navigate to /sales → Reports
3. View sales by branch, category, time period
4. Export to CSV
```

---

## Troubleshooting

### Cannot Login?

1. ✅ Verify backend is running: `docker compose ps`
2. ✅ Check database connection: `npm run db:seed`
3. ✅ Clear browser cache and cookies
4. ✅ Check browser console for errors

### Seed Data Not Loaded?

```bash
# Reset and re-seed the database
cd backend
npm run db:reset
npm run db:seed
npm start
```

### Wrong Password Message?

**This is expected behavior** — rate limiting and security measures:
- After 5 wrong attempts: 15-minute lockout
- Same response for unknown email and wrong password (security feature)
- Use the "Forgot Password" flow for actual resets in demo

---

## Security in Development

This project follows security best practices:

✅ **Passwords hashed** with Argon2id  
✅ **Session tokens** with expiry and rotation  
✅ **Rate limiting** on login attempts  
✅ **Account lockout** after failed attempts  
✅ **Row-level security** (RLS) in database  
✅ **Cross-tenant isolation** tested  

See [SECURITY_REPORT.md](./SECURITY_REPORT.md) for detailed security analysis.

---

## For CI/CD and Automated Testing

The test suite uses seeded data:

```bash
# Run all tests
npm test

# Run specific test file
npm test -- test/auth.e2e-spec.ts

# Tests automatically use the seeded data
```

---

## Questions or Issues?

Refer to:
- [README.md](./README.md) — General setup
- [BACKEND_IMPLEMENTATION.md](./BACKEND_IMPLEMENTATION.md) — Architecture
- [backend/README.md](./backend/README.md) — Backend API docs
- Backend documentation in `backend/docs/`

