# Database Migration Guide - UserType Separation

## Overview
This migration adds the `userType` field to separate "Login for Yourself" (SELF) users from "Login for Someone Else" (OTHER) viewers.

## Migration Steps

### Option 1: Using Prisma Migrate (Recommended)

If you have database access locally:

```bash
# Generate migration
npx prisma migrate dev --name add_user_type_separation

# This will:
# 1. Create a migration file
# 2. Apply it to your database
# 3. Regenerate Prisma Client
```

### Option 2: Using Prisma DB Push (Development)

```bash
npx prisma db push
```

**⚠️ Warning**: `db push` applies schema changes directly without creating migration files. Use this for development only.

### Option 3: Manual SQL Migration (If Prisma doesn't work)

Run this SQL in your Supabase SQL Editor:

```sql
-- 1. Create the UserType enum
CREATE TYPE "UserType" AS ENUM ('SELF', 'OTHER');

-- 2. Add userType column with default value
ALTER TABLE "users" 
ADD COLUMN "user_type" "UserType" NOT NULL DEFAULT 'SELF';

-- 3. Add viewedUserId column (nullable, for OTHER users)
ALTER TABLE "users" 
ADD COLUMN "viewed_user_id" TEXT;

-- 4. Add foreign key constraint for viewedUserId
ALTER TABLE "users" 
ADD CONSTRAINT "users_viewed_user_id_fkey" 
FOREIGN KEY ("viewed_user_id") 
REFERENCES "users"("id") 
ON DELETE CASCADE;

-- 5. Add indexes for performance
CREATE INDEX "users_user_type_idx" ON "users"("user_type");
CREATE INDEX "users_viewed_user_id_idx" ON "users"("viewed_user_id");

-- 6. Update UserSettings table with new fields
ALTER TABLE "user_settings" 
ADD COLUMN "last_period_date" TIMESTAMP(3),
ADD COLUMN "period_duration" INTEGER DEFAULT 5,
ADD COLUMN "birth_year" INTEGER;

-- 7. Update existing users to SELF type (they're already defaulted, but this ensures consistency)
UPDATE "users" SET "user_type" = 'SELF' WHERE "user_type" IS NULL;
```

### Option 4: Via Vercel (After Deployment)

After deploying to Vercel:

1. Go to your Vercel project settings
2. Open the database connection (Supabase)
3. Run the SQL migration manually in Supabase SQL Editor
4. Or use Prisma Studio connected to your production database

## Verification

After migration, verify the changes:

```sql
-- Check that all existing users are SELF
SELECT COUNT(*) FROM "users" WHERE "user_type" = 'SELF';

-- Check schema
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'users' 
AND column_name IN ('user_type', 'viewed_user_id');
```

## Backward Compatibility

The code has been updated to handle:
- Users without `userType` field (treated as SELF)
- Automatic migration of existing users to SELF type
- Graceful fallback if schema hasn't been updated yet

However, **you should still run the migration** to ensure proper functionality.

## Troubleshooting

### Error: "column user_type does not exist"
- The migration hasn't been applied yet
- Run one of the migration options above

### Error: "type UserType does not exist"
- The enum hasn't been created
- Use Option 3 (Manual SQL) to create the enum first

### Error: "Cannot read property 'userType' of undefined"
- The Prisma Client is out of date
- Run: `npx prisma generate`

## Next Steps

After migration:
1. Deploy the updated backend code
2. Test "Login for Yourself" flow (should create SELF users)
3. Test "Login for Someone Else" flow (should create OTHER users linked to SELF users)
4. Verify data access permissions are working correctly

