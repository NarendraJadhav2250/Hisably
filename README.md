# SplitSmart

SplitSmart is a Next.js App Router application for recording shared expenses, calculating balances in integer minor units, and confirming settlements. Supabase Auth and Postgres are the persistence and authorization layer. Gemini parsing is optional and only creates a reviewable draft.

## Local setup

Requirements: Node.js 18.17 or newer and an existing Supabase project.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set these values in `.env.local`:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
GEMINI_API_KEY=YOUR_SERVER_SIDE_GEMINI_KEY
```

The first two values are public client configuration; database access is restricted by RLS. Never place a Supabase service-role/secret key in a `NEXT_PUBLIC_` variable. `GEMINI_API_KEY` is read only by the server route. AI is optional; the ordinary expense workflow does not use it.

## Supabase database

1. Back up any existing project data and review the migration before applying it.
2. In Supabase SQL Editor, run `supabase/migrations/202611040001_splitsmart_core.sql` once. It extends the starter’s existing `groups`, `group_members`, and `expenses` tables; it is not intended to be run against an unrelated production schema without review.
3. Confirm that the migration succeeds and that the `group-receipts` Storage bucket is private.
4. In Authentication settings, set the Site URL to the local app origin for development and add the production and preview origins you use to the redirect allow list. Configure email verification and production SMTP before inviting customers.
5. Enable Google OAuth only after configuring the provider credentials and the matching Supabase callback URL.

Group creation, guest-member addition, expense creation, and settlement recording run through Postgres functions with authorization checks. Client reads are protected by RLS. Expense amounts and splits are stored as integer minor units. Only completed settlements affect balances; a payer must explicitly confirm a payment, and the database rejects transfers that exceed current balances.

## Gemini

Set `GEMINI_API_KEY` in local server environment and Vercel project settings. `/api/ai/expense` requires a valid Supabase access token and membership in the selected group, limits prompt length, sends only group member display names and the user's expense text, and validates the returned fields. The resulting details are editable and are not written until the user submits the regular expense form.

## Vercel deployment

1. Import the Git repository into Vercel. Set the project root to the directory containing this `package.json` if the repository contains a parent folder.
2. Add `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and optionally `GEMINI_API_KEY` to the appropriate Development, Preview, and Production environments.
3. Set Supabase Auth Site URL and redirect allow lists for the deployed domain.
4. Deploy a Preview, verify sign-up, group creation, expense splitting, RLS behavior, and the AI draft flow, then promote to Production.
5. Apply database migrations deliberately; do not make a production deploy responsible for applying schema changes.

The repository does not contain project credentials and no Vercel deployment has been performed from this workspace. Production connectivity must be verified against your own Supabase and Vercel projects.

## Commands

```bash
npm run dev
npm test
npm run lint
npm run build
npm start
```

## Current scope and follow-up

Implemented: email/password auth, password reset, optional Google OAuth, group creation, guest members, group-scoped expenses, equal/exact/percentage/weighted split validation, balances, settlement recommendations, explicit payer confirmation, settlement history, RLS/RPC migration, private receipt bucket policies, and optional Gemini expense drafts.

Before opening this to customers, complete a Supabase migration review on a staging project, add database integration tests for RLS/RPC behavior, configure rate limiting for the AI endpoint, and verify email delivery and OAuth redirects. Registered-user invitation delivery, member removal, expense edit/delete, receipt upload UI, exports, recurring expenses, notifications, and a production Vercel deployment are not implemented yet.