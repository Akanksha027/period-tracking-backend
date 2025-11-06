-- Safe cleanup script for misconfigured OTHER users
-- This only deletes OTHER users that are incorrectly configured
-- It does NOT delete SELF users or their data (periods, symptoms, moods, etc.)

-- Step 1: Check what OTHER users exist
SELECT 
  id,
  email,
  clerk_id,
  user_type,
  viewed_user_id,
  created_at
FROM users
WHERE user_type = 'OTHER';

-- Step 2: Delete OTHER users that have NULL clerk_id (these are old/misconfigured)
-- These will be recreated correctly when you log in "for someone else" again
DELETE FROM users
WHERE user_type = 'OTHER' 
  AND clerk_id IS NULL;

-- Step 3: (Optional) Delete ALL OTHER users if you want a complete reset
-- Uncomment the line below if you want to delete all OTHER users
-- DELETE FROM users WHERE user_type = 'OTHER';

-- Note: This will NOT delete:
-- - SELF users (akankshu07@gmail.com, akankshasingh0085@gmail.com)
-- - Their periods, symptoms, moods, settings, etc.
-- - The relationship between users

