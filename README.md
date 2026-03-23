# Ikka Dukka — Catalogue Engine

Standalone AI-assisted catalogue query and PDF generation tool.

## Setup

1. Clone this repo
2. Copy `.env.example` to `.env` and fill in your values:

```
VITE_SUPABASE_URL=         # from Supabase → Settings → API
VITE_SUPABASE_ANON_KEY=    # from Supabase → Settings → API
VITE_CATALOGUE_SERVICE_URL=https://ikka-catalogue-service-production.up.railway.app
```

3. Install and run:

```bash
npm install
npm run dev
```

## Deploy to Vercel

1. Create new Vercel project → import this repo
2. Add the three environment variables above in Vercel → Settings → Environment Variables
3. Deploy

## Features

- **Query tab** — filter by budget, quantity, timeline, occasion, restrictions
- AI scoring ranks products by fit (0–100% match)
- Auto-selects products above 40% match score
- Preview catalogue inline before generating
- PDF generated via Railway service, saved to Supabase Storage with shareable link

- **Admin tab** — add / edit products, manage attributes
- New products automatically get pricing tiers seeded (retail → 40% discount at 1000+ units)

## Supabase tables used

- `catalog` — products
- `pricing_tiers` — quantity-based pricing per product
- `client_requests` — logs every query for analytics
