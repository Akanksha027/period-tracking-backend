# Serverless Function Crash Fix

## Problem

The `/health` endpoint was crashing with `FUNCTION_INVOCATION_FAILED` even though it's a simple endpoint that doesn't use Supabase or Prisma.

## Root Cause

When `server.js` imports route files (`routes/auth.js`, `routes/user.js`, `routes/login-for-other.js`), those routes import `lib/supabase.js` and `lib/prisma.js` at the top level.

The original `lib/supabase.js` code was:
```javascript
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}
```

This check happened **immediately when the module was loaded**, before any request could be handled. Even though the `/health` endpoint doesn't need Supabase, the module import crashed the entire serverless function.

## Solution

Changed both `lib/supabase.js` and `lib/prisma.js` to use **lazy initialization**:

1. **Supabase clients** are only created when actually accessed (using JavaScript Proxy)
2. **Prisma client** is only created when actually accessed
3. **Error checking** only happens when the clients are actually used

This means:
- ✅ The `/health` endpoint works even if routes import these modules
- ✅ Other endpoints still work normally
- ✅ Errors only occur when you actually try to use Supabase/Prisma, not at startup

## Files Changed

- `lib/supabase.js` - Lazy initialization with Proxy
- `lib/prisma.js` - Lazy initialization with Proxy

## Testing

After deploying, test the health endpoint:
```bash
curl https://period-tracking-backend.vercel.app/health
```

Should return:
```json
{"status":"ok","timestamp":"2024-11-05T..."}
```

## Note

The Proxy approach allows the exported objects to work exactly like before - you can still use:
- `supabase.auth.getUser()`
- `prisma.user.findMany()`
- etc.

The lazy initialization is transparent to the code using these modules.
