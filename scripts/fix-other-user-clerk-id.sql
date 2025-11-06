-- Fix script: Update OTHER user (Row 3) with akankshu07's Clerk ID
-- This will allow akankshu07@gmail.com to view akankshasingh0085@gmail.com's data

-- Update Row 3: Set clerk_id to akankshu07's Clerk ID
-- Correct ID from database: a0977572-130f-4c42-8c4c-d783cb59a420
UPDATE users
SET clerk_id = 'user_357Dq0GrvVFb4xYw24K3oxGC3IY'
WHERE id = 'a0977572-130f-4c42-8c4c-d783cb59a420'
  AND user_type = 'OTHER';

-- Verify the update
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

-- Expected result after running:
-- Row 3 should now have:
-- - clerk_id: 'user_357Dq0GrvVFb4xYw24K3oxGC3IY'
-- - viewed_user_id: '530d136c-1b11-44e9-a3e1-0b1bd5a22d71' (akankshasingh0085's SELF user)

