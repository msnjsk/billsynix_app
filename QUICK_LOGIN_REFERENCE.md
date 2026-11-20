# Quick Login Reference

## 🚀 TL;DR - Owner Account

```
📧 Email:    owner@demo.test
🔑 Password: demo-password-123
```

## Setup Before First Login

```bash
# 1. Start the backend
cd backend
docker compose --profile api up

# 2. In another terminal, seed the database
npm run db:seed

# 3. Start the frontend
npm run dev
```

## 🌐 Access URLs

- **Frontend:** http://localhost:3000
- **Backend API:** http://localhost:4000
- **API v1:** http://localhost:4000/api/v1

---

## Demo Business Info

**Name:** Sri Lakshmi Supermarket  
**Location:** Anna Nagar, Chennai

### Branches
| Branch | Code | Counter |
|--------|------|---------|
| HQ | AN | Counter 1 |
| Secondary | TN | Counter 2 |

---

## Role Quick Access

After login, switch roles via `/branches`:

| Role | Email | Access |
|------|-------|--------|
| Owner | owner@demo.test | Full system |
| Branch Manager | manager@demo.test * | Single branch |
| Cashier | cashier@demo.test * | POS only |

*May vary—check seed data or staff setup

---

## Common Tests

| Task | URL | Notes |
|------|-----|-------|
| Dashboard | `/` | Overview |
| POS/Sales | `/pos` | Process bills |
| Inventory | `/inventory` | Stock management |
| Products | `/products` | Manage catalogue |
| Reports | `/sales` | View analytics |
| Settings | `/branches` | Setup & config |

---

## API Quick Test

```bash
# Login and get token
curl -X POST http://localhost:4000/api/v1/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@demo.test","password":"demo-password-123"}'

# Use token in next request
curl -X GET http://localhost:4000/api/v1/products \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Need Help?

📖 See [TEST_CREDENTIALS.md](./TEST_CREDENTIALS.md) for detailed docs  
🔒 Security info: [SECURITY_REPORT.md](./SECURITY_REPORT.md)  
🏗️ Architecture: [BACKEND_IMPLEMENTATION.md](./BACKEND_IMPLEMENTATION.md)
