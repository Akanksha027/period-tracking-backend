# Adding Reminders Table Without Resetting Database

Since you have existing data, we need to add the `reminders` table without resetting the database.

## Option 1: Use Prisma DB Push (Recommended)

Run this command instead of migrate:

```bash
cd priod-tracker-backend
npx prisma db push
```

This will add the new `reminders` table without affecting existing data.

## Option 2: Run SQL Manually

If `db push` doesn't work, you can run the SQL directly in Supabase:

1. Go to your Supabase dashboard
2. Navigate to SQL Editor
3. Run the SQL from `migrations/add_reminders_table.sql`

Or run it via psql:

```bash
psql <your-database-url> -f migrations/add_reminders_table.sql
```

## Option 3: Mark Migration as Applied

If the table already exists, you can mark the migration as applied:

```bash
npx prisma migrate resolve --applied add_reminders
```

## Verify the Table

After adding the table, verify it exists:

```bash
npx prisma studio
```

Or check in Supabase dashboard under "Table Editor" - you should see the `reminders` table.

