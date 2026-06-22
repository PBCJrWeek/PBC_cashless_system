# Bible Camp Canteen App

Netlify-hosted React app with Supabase Free for camper balances, barcode checkout, deposits, and transaction reporting.

## Included features

- Staff email/password sign-in with Supabase Auth
- Camper search by ID, name, cabin, or barcode
- Camera barcode scanner for camper lookup
- Camera barcode scanner for item lookup and price loading
- Deposit money during the week
- Transaction report filtering and CSV export
- Store item catalog with barcode + price
- Safe atomic balance updates through a Supabase Postgres RPC
- CSV import for campers and store items with downloadable templates

## Stack

- Frontend: React + Vite
- Hosting: Netlify
- Database/Auth: Supabase Free
- Camera barcode scanning: `html5-qrcode`

## 1. Create the Supabase project

Create a Supabase Free project.

In **Authentication > Providers > Email**:
- Keep email/password enabled
- For fastest setup, you can disable email confirmation for staff

## 2. Run the SQL schema

Open the Supabase SQL Editor and run:

`supabase/schema.sql`

This creates:
- `campers`
- `store_items`
- `transactions`
- row-level security policies
- `apply_camper_transaction(...)` RPC
- sample campers and sample store items

## 3. Configure the frontend

Copy `.env.example` to `.env` and fill in:

```bash
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

## 4. Run locally

```bash
npm install
npm run dev
```

## 5. Deploy to Netlify

Deploy this repo to Netlify.

Build settings:
- Build command: `npm run build`
- Publish directory: `dist`

Environment variables:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## How barcode flow works

### Camper lookup
Use either:
- a USB barcode scanner that types into the camper barcode field, or
- the camera scanner in the browser

By default, each camper barcode is the same as the camper ID. You can later print Code 128 labels using that value.

### Item charging
Each store item has:
- item name
- barcode
- price

Scan the item barcode and the app loads the item and price, then save the charge to the selected camper.

## CSV import

The app now includes in-app CSV import for:
- campers
- store items

Camper CSV columns:
- required: `camper_id`, `full_name`
- optional: `cabin`, `barcode_value`, `starting_balance`

Store item CSV columns:
- required: `item_name`, `barcode_value`, `price`

Uploading the file will upsert rows into Supabase:
- campers match on `camper_id`
- store items match on `barcode_value`

## Reports

The report panel supports:
- all transactions
- charges only
- deposits only
- date range filters
- CSV export

## Operational notes

- Supabase Free is large enough for your expected camp usage.
- Free projects can pause after inactivity, so test sign-in and one sample transaction before camp starts.
- Camera scanning requires HTTPS in production, which Netlify provides by default.

## Recommended next additions

- CSV import for campers and store items
- Admin-only staff roles
- Refund / void transactions
- Printable barcode labels for campers and items
