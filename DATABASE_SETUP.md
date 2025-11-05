# Database Connection Setup Guide

## Problem
You're getting this error:
```
Error: P1000: Authentication failed against database server
```

This means your `.env` file still has the placeholder `[YOUR-PASSWORD]` instead of your actual database password.

## Solution

### Step 1: Get Your Database Password

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project: `mclzuszfbmrqvhrtnzvq`
3. Go to **Settings** → **Database**
4. Find the **Database Password** section
5. If you don't know your password, click **Reset Database Password**
6. Copy the password (you'll only see it once!)

### Step 2: Update Your `.env` File

Open your `.env` file and replace `[YOUR-PASSWORD]` with your actual password in both connection strings.

**Before:**
```env
DATABASE_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:[YOUR-PASSWORD]@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:[YOUR-PASSWORD]@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres
```

**After (example with password `MyPassword123!`):**
```env
DATABASE_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:MyPassword123!@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:MyPassword123!@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres
```

### Step 3: Important Notes

⚠️ **Special Characters in Password:**
If your password contains special characters (like `@`, `#`, `$`, `%`, etc.), you need to URL-encode them:

| Character | URL-Encoded |
|-----------|-------------|
| `@` | `%40` |
| `#` | `%23` |
| `$` | `%24` |
| `%` | `%25` |
| `&` | `%26` |
| `/` | `%2F` |
| `?` | `%3F` |
| `=` | `%3D` |
| `+` | `%2B` |

**Example:** If your password is `P@ssw0rd#123`, use `P%40ssw0rd%23123`

### Step 4: Alternative - Get Connection String from Supabase

You can also copy the connection string directly from Supabase:

1. Go to **Settings** → **Database**
2. Scroll down to **Connection string** section
3. Select **URI** tab
4. Copy the connection string
5. Replace `DATABASE_URL` with the pooled connection (port 6543)
6. Replace `DIRECT_URL` with the direct connection (port 5432)

### Step 5: Test the Connection

After updating your `.env` file, try pushing the schema again:

```bash
npm run prisma:push
```

If it works, you should see:
```
✔ Prisma schema pushed to database
```

## Quick Fix Command (PowerShell)

If you know your password, you can quickly update the `.env` file using PowerShell:

```powershell
$password = "YOUR_ACTUAL_PASSWORD_HERE"
$content = Get-Content .env -Raw
$content = $content -replace '\[YOUR-PASSWORD\]', $password
Set-Content .env $content
```

Then verify:
```powershell
Get-Content .env | Select-String "DATABASE_URL|DIRECT_URL"
```

Make sure `[YOUR-PASSWORD]` is replaced with your actual password!

## Still Having Issues?

1. **Check if password has special characters** - URL encode them
2. **Verify the password** - Make sure you copied it correctly
3. **Try resetting the password** - Sometimes it's easier to reset and use a new one
4. **Check Supabase project status** - Make sure your project is active
5. **Verify connection strings** - Make sure ports are correct (6543 for pooled, 5432 for direct)
