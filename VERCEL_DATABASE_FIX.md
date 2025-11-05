# Fix DATABASE_URL Invalid Port Error in Vercel

The error "invalid port number in database URL" usually means the password contains special characters that need URL encoding.

## Quick Fix Steps:

### Option 1: Get Pre-Encoded Connection String from Supabase (Recommended)

1. Go to your Supabase Dashboard: https://supabase.com/dashboard
2. Select your project: `period-support`
3. Go to **Settings** → **Database**
4. Scroll to **Connection string**
5. Copy the **URI** format (not the JDBC or other formats)
6. It will look like:
   ```
   postgresql://postgres.mclzuszfbmrqvhrtnzvq:[PASSWORD]@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
   ```
7. The password in this string is **already URL-encoded** if you copy it from Supabase

### Option 2: Manually Encode Password

If you know your database password, you need to URL-encode special characters:

**Special Characters that Need Encoding:**
- `@` → `%40`
- `#` → `%23`
- `$` → `%24`
- `%` → `%25`
- `&` → `%26`
- `/` → `%2F`
- `?` → `%3F`
- `=` → `%3D`
- `:` → `%3A`

**Example:**
If your password is `P@ssw0rd#123`, the encoded version is `P%40ssw0rd%23123`

The connection string would be:
```
postgresql://postgres.mclzuszfbmrqvhrtnzvq:P%40ssw0rd%23123@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
```

### Option 3: Use Online URL Encoder

1. Take your password
2. Go to https://www.urlencoder.org/
3. Encode only the password part
4. Replace `[YOUR-PASSWORD]` in the connection string with the encoded version

## Update Vercel Environment Variables:

1. Go to Vercel Dashboard: https://vercel.com/dashboard
2. Select your project: `period-tracking-backend`
3. Go to **Settings** → **Environment Variables**
4. Update `DATABASE_URL` with the properly encoded connection string
5. Update `DIRECT_URL` with the direct connection (port 5432) - also properly encoded
6. **Important:** Make sure there are **NO quotes** around the values in Vercel
7. Click **Save**
8. **Redeploy** your project (or wait for auto-deployment)

## Format Examples:

**DATABASE_URL (Pooler - Port 6543):**
```
postgresql://postgres.mclzuszfbmrqvhrtnzvq:ENCODED_PASSWORD@aws-1-ap-southeast-2.pooler.supabase.com:6543/postgres?pgbouncer=true
```

**DIRECT_URL (Direct - Port 5432):**
```
postgresql://postgres.mclzuszfbmrqvhrtnzvq:ENCODED_PASSWORD@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres
```

Replace `ENCODED_PASSWORD` with your actual URL-encoded password.

## Verify Connection:

After updating, check the Vercel deployment logs to ensure:
- Prisma can connect to the database
- No "invalid port number" errors
- The application starts successfully
