# Quick Fix for Vercel 500 Error

## What Was Fixed

1. ✅ Created `vercel.json` - Configures Vercel to use serverless functions
2. ✅ Created `api/index.js` - Serverless function handler for Express app
3. ✅ Modified `server.js` - Prevents starting HTTP server in Vercel environment
4. ✅ Fixed `routes/login-for-other.js` - Prevents setInterval in serverless environment

## Files Created/Modified

- ✅ `vercel.json` - Vercel configuration
- ✅ `api/index.js` - Serverless function entry point
- ✅ `server.js` - Updated to work in serverless environment
- ✅ `routes/login-for-other.js` - Fixed setInterval issue

## Next Steps

### 1. Commit and Push Changes

```bash
git add .
git commit -m "Fix Vercel deployment configuration"
git push
```

### 2. Add Environment Variables in Vercel

Go to: **Vercel Dashboard → Your Project → Settings → Environment Variables**

Add these variables (replace `[YOUR-PASSWORD]` with actual password):

```
PORT=3001
SUPABASE_URL=https://mclzuszfbmrqvhrtnzvq.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbHp1c3pmYm1ycXZocnRuenZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzMTMzNzYsImV4cCI6MjA3Nzg4OTM3Nn0.6KY_ouo_1zXuBsIgsiiSfqpOlDB9vWV8Cw36KsX9Rg4
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbHp1c3pmYm1ycXZocnRuenZxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MjMxMzM3NiwiZXhwIjoyMDc3ODg5Mzc2fQ.Xtx1D7nYXFkzq4AYuWob7mtMMnm0PScNYbQezxklFh8
DATABASE_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:[YOUR-PASSWORD]@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:[YOUR-PASSWORD]@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres
```

### 3. Redeploy

Vercel will automatically redeploy when you push. Or manually trigger:
- Go to Vercel Dashboard → Your Project → Deployments
- Click "Redeploy" on the latest deployment

### 4. Test

After deployment, test:

```
https://your-project.vercel.app/health
```

Should return: `{"status":"ok","timestamp":"..."}`

## Important Notes

⚠️ **OTP Storage Issue in Serverless:**
The current OTP storage uses in-memory Map, which won't work in serverless environments. For production, you'll need to:
- Use Vercel KV (Redis) or Supabase Database to store OTPs
- Or use an external Redis service

See `DEPLOYMENT.md` for detailed instructions.

## Your Backend URL

After successful deployment, your backend will be available at:
```
https://your-project-name.vercel.app
```

Use this URL in your frontend configuration.
