# Akawo Fintech Savings App (MVP)

Web application MVP for Nigerian users with:

- Personal locked savings
- Group rotational contributions (circle/ajo)
- Paystack-compatible webhook and payout flow
- Platform fee model and admin revenue tracking

## Implemented business-critical updates from your request

1. **1.5% platform fee on personal withdrawals**
   - Applied when a personal locked savings withdrawal is processed.
   - **Fee cap is ₦10,000** per withdrawal.
   - Fee posted to immutable revenue ledger and attributed to owner account.

2. **1.5% platform fee on circle payouts**
   - Applied on automated group payout disbursement.
   - **Fee cap is ₦10,000** per payout.
   - Revenue posted to owner revenue ledger.

3. **Admin revenue panel**
   - Route: `/admin`
   - Shows total fee revenue, split by:
     - Personal withdrawal fees
     - Circle payout fees
   - Displays owner account attribution and fee settings.

4. **Push invite join model using phone lookup**
   - Group creator searches users by phone number.
   - Creator sends invite (push invite record is created).
   - Invitee must acknowledge in app dashboard before joining.
   - Join only completes after explicit invitee acceptance.
   - Buffer requirement is checked before acceptance.

## Stack

- Next.js (App Router) + TypeScript
- Prisma ORM + SQLite (local MVP DB)
- API routes for backend logic

## Key routes

- `/dashboard` – savings, deposits, withdrawals, invite acknowledgments
- `/groups` – group creation, phone search, push invites, allocations, payouts
- `/admin` – revenue and fee tracking

### API

- `GET/POST /api/mvp` action-based endpoint (core operations)
- `POST /api/webhook/paystack` paystack webhook (signature checked)
- `GET /api/cron/daily` daily missed contribution notifications
- `GET /api/cron/monthly` monthly allocations
- `GET /api/cron/payout` automated payouts

## Local setup

```bash
npm install
cp .env.example .env.local
npm run prisma:generate
npm run prisma:push
npm run dev
```

Open:

- `http://localhost:3000/dashboard`
- `http://localhost:3000/groups`
- `http://localhost:3000/admin`

## Notes

- Ledger tables are append-only for transaction and revenue events.
- Withdrawal logic enforces lock date and considers group obligations.
- Group payout is blocked while carry-over obligations exist.
- A seeded set of demo users is auto-created on first run.
