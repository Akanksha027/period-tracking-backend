-- Fix script for OTHER users
-- This will fix the misconfigured OTHER users

-- IMPORTANT: Run these one at a time and verify after each step!

-- Step 1: Delete the incorrect OTHER user (Row 3)
-- This points to akankshu07's own SELF user (wrong!)
-- We want akankshu07 to view akankshasingh0085, not themselves
DELETE FROM users
WHERE id = '79b0af87-4bff-4ef0-8192-d536b04f1da6'
  AND user_type = 'OTHER';

-- Step 2: Update Row 4 to add the correct clerk_id
-- This OTHER user already has the correct viewed_user_id (akankshasingh0085)
-- We just need to add akankshu07's Clerk ID so the system can find it
UPDATE users
SET clerk_id = 'user_357Dq0GrvVFb4xYw24K3oxGC3IY'
WHERE id = 'a0977572-130f-4c42-8c4c-d783cb69a420'
  AND user_type = 'OTHER'
  AND viewed_user_id = '530d136c-1b11-44e9-a3e1-0b1bd5a22d71';

-- Step 3: Verify the fix
-- After running the above, you should see only ONE OTHER user with:
-- clerk_id = 'user_357Dq0GrvVFb4xYw24K3oxGC3IY'
-- viewed_user_id = '530d136c-1b11-44e9-a3e1-0b1bd5a22d71'
SELECT 
  id,
  email,
  clerk_id,
  user_type,
  viewed_user_id,
  name,
  created_at
FROM users
WHERE user_type = 'OTHER'
ORDER BY created_at DESC;

