# Vercel Environment Variables Setup

## Problem

Your Vercel deployment is failing with this error:
```
Error: Missing Supabase environment variables
```

This means the environment variables haven't been added to your Vercel project.

## Solution: Add Environment Variables to Vercel

### Step 1: Go to Vercel Dashboard

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Find and click on your project: **period-tracking-backend** (or whatever you named it)
3. Click on **Settings** tab
4. Click on **Environment Variables** in the left sidebar

### Step 2: Add Required Environment Variables

Click **Add New** and add each of these variables:

#### 1. PORT
- **Name:** `PORT`
- **Value:** `3001`
- **Environment:** Select all (Production, Preview, Development)

#### 2. SUPABASE_URL
- **Name:** `SUPABASE_URL`
- **Value:** `https://mclzuszfbmrqvhrtnzvq.supabase.co`
- **Environment:** Select all

#### 3. SUPABASE_ANON_KEY
- **Name:** `SUPABASE_ANON_KEY`
- **Value:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbHp1c3pmYm1ycXZocnRuenZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzMTMzNzYsImV4cCI6MjA3Nzg4OTM3Nn0.6KY_ouo_1zXuBsIgsiiSfqpOlDB9vWV8Cw36KsX9Rg4`
- **Environment:** Select all

#### 4. SUPABASE_SERVICE_ROLE_KEY
- **Name:** `SUPABASE_SERVICE_ROLE_KEY`
- **Value:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbHp1c3pmYm1ycXZocnRuenZxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MjMxMzM3NiwiZXhwIjoyMDc3ODg5Mzc2fQ.Xtx1D7nYXFkzq4AYuWob7mtMMnm0PScNYbQezxklFh8`
- **Environment:** Select all

#### 5. DATABASE_URL
- **Name:** `DATABASE_URL`
- **Value:** `postgresql://postgres.mclzuszfbmrqvhrtnzvq:YOUR_PASSWORD@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true`
- **Replace `YOUR_PASSWORD` with your actual Supabase database password**
- **Environment:** Select all

#### 6. DIRECT_URL
- **Name:** `DIRECT_URL`
- **Value:** `postgresql://postgres.mclzuszfbmrqvhrtnzvq:YOUR_PASSWORD@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres`
- **Replace `YOUR_PASSWORD` with your actual Supabase database password**
- **Environment:** Select all

### Step 3: Important Notes

⚠️ **Password Encoding:**
If your database password contains special characters (`@`, `#`, `$`, etc.), you MUST URL-encode them in the connection strings.

| Character | URL-Encoded |
|-----------|-------------|
| `@` | `%40` |
| `#` | `%23` |
| `$` | `%24` |
| `%` | `%25` |
| `&` | `%26` |

Example: If password is `P@ss123`, use `P%40ss123` in the connection string.

### Step 4: Redeploy

After adding all environment variables:

1. Go to **Deployments** tab
2. Click the **three dots (⋯)** on the latest deployment
3. Click **Redeploy**
4. Or push a new commit to trigger automatic redeploy

### Step 5: Verify

After redeployment, test your backend:

```bash
curl https://period-tracking-backend.vercel.app/health
```

Should return:
```json
{"status":"ok","timestamp":"2024-11-05T..."}
```

## Quick Copy-Paste Checklist

Here are all the variables you need to add:

```
✅ PORT=3001
✅ SUPABASE_URL=https://mclzuszfbmrqvhrtnzvq.supabase.co
✅ SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbHp1c3pmYm1ycXZocnRuenZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzMTMzNzYsImV4cCI6MjA3Nzg4OTM3Nn0.6KY_ouo_1zXuBsIgsiiSfqpOlDB9vWV8Cw36KsX9Rg4
✅ SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbHp1c3pmYm1ycXZocnRuenZxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MjMxMzM3NiwiZXhwIjoyMDc3ODg5Mzc2fQ.Xtx1D7nYXFkzq4AYuWob7mtMMnm0PScNYbQezxklFh8
✅ DATABASE_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:YOUR_PASSWORD@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
✅ DIRECT_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:YOUR_PASSWORD@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres
```

**Don't forget:** Replace `YOUR_PASSWORD` in `DATABASE_URL` and `DIRECT_URL` with your actual Supabase database password!

## Troubleshooting

### Still getting "Missing Supabase environment variables"?
1. Make sure you added ALL 6 variables
2. Make sure you selected **all environments** (Production, Preview, Development) for each variable
3. **Redeploy** after adding variables (they don't apply to existing deployments)
4. Check that variable names match exactly (case-sensitive)

### Variables not working after redeploy?
- Sometimes Vercel caches old deployments
- Try: **Settings → Environment Variables → Redeploy all deployments**
- Or create a new deployment by pushing a commit

### How to get your database password?
- Go to: https://supabase.com/dashboard/project/mclzuszfbmrqvhrtnzvq/settings/database
- Scroll to **Database Password** section
- Copy or reset your password
