# Vercel Deployment Guide

## Prerequisites

1. A Vercel account (sign up at https://vercel.com)
2. Your backend code pushed to GitHub/GitLab/Bitbucket
3. Supabase credentials ready

## Deployment Steps

### 1. Connect Your Repository to Vercel

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Click "Add New Project"
3. Import your Git repository
4. Select the repository containing `priod-tracker-backend`

### 2. Configure Build Settings

Vercel will auto-detect the settings, but verify:

- **Framework Preset**: Other
- **Root Directory**: `priod-tracker-backend` (if your repo has multiple folders)
- **Build Command**: (leave empty - not needed)
- **Output Directory**: (leave empty)
- **Install Command**: `npm install`

### 3. Add Environment Variables

In Vercel project settings, go to **Settings → Environment Variables** and add:

```
PORT=3001
SUPABASE_URL=https://mclzuszfbmrqvhrtnzvq.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbHp1c3pmYm1ycXZocnRuenZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzMTMzNzYsImV4cCI6MjA3Nzg4OTM3Nn0.6KY_ouo_1zXuBsIgsiiSfqpOlDB9vWV8Cw36KsX9Rg4
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1jbHp1c3pmYm1ycXZocnRuenZxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MjMxMzM3NiwiZXhwIjoyMDc3ODg5Mzc2fQ.Xtx1D7nYXFkzq4AYuWob7mtMMnm0PScNYbQezxklFh8
DATABASE_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:[YOUR-PASSWORD]@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.mclzuszfbmrqvhrtnzvq:[YOUR-PASSWORD]@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres
```

**Important:** 
- Replace `[YOUR-PASSWORD]` with your actual Supabase database password
- Set these for all environments (Production, Preview, Development)

### 4. Deploy

1. Click "Deploy"
2. Wait for the build to complete
3. Your backend will be available at `https://your-project-name.vercel.app`

## After Deployment

### Test Your Deployment

1. Check health endpoint:
   ```
   https://your-project-name.vercel.app/health
   ```

2. Test an API endpoint:
   ```bash
   curl https://your-project-name.vercel.app/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email":"test@example.com","password":"test123"}'
   ```

### Update Frontend Configuration

Update your frontend to use the deployed backend URL:

```javascript
// In your frontend config
const API_URL = 'https://your-project-name.vercel.app'
```

## Common Issues

### Issue: 500 Internal Server Error

**Solution:**
1. Check Vercel logs (Deployments → Click on deployment → Logs)
2. Verify all environment variables are set correctly
3. Make sure your Supabase credentials are correct
4. Check that the database password is correct in DATABASE_URL and DIRECT_URL

### Issue: Function Invocation Failed

**Solution:**
1. Ensure `vercel.json` is in the root directory
2. Verify `api/index.js` exists
3. Check that all imports use `.js` extension (ES modules)
4. Make sure `package.json` has `"type": "module"`

### Issue: Environment Variables Not Working

**Solution:**
1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Make sure variables are added for the correct environment (Production/Preview/Development)
3. Redeploy after adding environment variables
4. Restart the deployment if needed

### Issue: CORS Errors

**Solution:**
- The backend already has CORS enabled
- If you still get CORS errors, add your frontend URL to allowed origins in `server.js`:
  ```javascript
  app.use(cors({
    origin: ['https://your-frontend-url.vercel.app', 'http://localhost:3000'],
    credentials: true
  }))
  ```

## Production Considerations

### 1. OTP Storage in Serverless Environment

The current implementation uses in-memory storage for OTPs. In a serverless environment like Vercel:
- Each function invocation is stateless
- OTPs stored in memory won't persist between requests

**Recommended Solution:**
- Use Vercel KV (Redis) or Supabase Database to store OTPs
- Or use an external Redis service

### 2. Rate Limiting

Consider adding rate limiting to prevent abuse:
```bash
npm install express-rate-limit
```

### 3. Monitoring

Set up monitoring and logging:
- Vercel Analytics
- Sentry for error tracking
- Log monitoring via Vercel dashboard

## Custom Domain (Optional)

1. Go to Vercel Project → Settings → Domains
2. Add your custom domain
3. Follow DNS configuration instructions

## Support

If you encounter issues:
1. Check Vercel deployment logs
2. Verify environment variables
3. Test endpoints with curl or Postman
4. Check Supabase dashboard for auth issues
