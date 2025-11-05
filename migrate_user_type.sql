-- Migration script to add userType column to users table
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/[YOUR_PROJECT]/sql/new

-- Step 1: Create the UserType enum (if it doesn't exist)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'UserType') THEN
        CREATE TYPE "UserType" AS ENUM ('SELF', 'OTHER');
    END IF;
END $$;

-- Step 2: Add userType column with default value 'SELF'
ALTER TABLE "users" 
ADD COLUMN IF NOT EXISTS "user_type" "UserType" NOT NULL DEFAULT 'SELF';

-- Step 3: Add viewedUserId column (for OTHER users to link to SELF users they're viewing)
ALTER TABLE "users" 
ADD COLUMN IF NOT EXISTS "viewed_user_id" TEXT;

-- Step 4: Add foreign key constraint for viewedUserId
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'users_viewed_user_id_fkey'
    ) THEN
        ALTER TABLE "users" 
        ADD CONSTRAINT "users_viewed_user_id_fkey" 
        FOREIGN KEY ("viewed_user_id") 
        REFERENCES "users"("id") 
        ON DELETE CASCADE;
    END IF;
END $$;

-- Step 5: Add indexes for performance
CREATE INDEX IF NOT EXISTS "users_user_type_idx" ON "users"("user_type");
CREATE INDEX IF NOT EXISTS "users_viewed_user_id_idx" ON "users"("viewed_user_id");

-- Step 6: Update UserSettings table with new fields
ALTER TABLE "user_settings" 
ADD COLUMN IF NOT EXISTS "last_period_date" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "period_duration" INTEGER DEFAULT 5,
ADD COLUMN IF NOT EXISTS "birth_year" INTEGER;

-- Step 7: Verify all existing users are set to SELF (they should be by default)
-- This query should show all users with user_type = 'SELF'
SELECT 
    id, 
    email, 
    name, 
    user_type, 
    viewed_user_id,
    created_at
FROM "users"
ORDER BY created_at DESC;

-- Step 8: Show summary
SELECT 
    user_type,
    COUNT(*) as user_count
FROM "users"
GROUP BY user_type;

