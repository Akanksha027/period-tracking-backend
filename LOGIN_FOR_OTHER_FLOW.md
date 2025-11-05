# Login For Someone Else - Implementation Guide

## Overview

This backend implements a secure "Login for Someone Else" flow that allows a user to log in on behalf of another user using email and OTP verification. This is useful for scenarios where a caregiver or partner needs to track someone else's period data.

## Flow Diagram

```
1. User clicks "Login for Someone Else"
   ↓
2. Frontend calls: POST /api/login-for-other/check-email
   - Validates that the email exists in Supabase Auth
   ↓
3. Frontend calls: POST /api/login-for-other/send-otp
   - Generates 6-digit OTP
   - Sends OTP to the target user's email
   - Stores OTP in memory (expires in 10 minutes)
   ↓
4. User enters OTP received via email
   ↓
5. Frontend calls: POST /api/login-for-other/verify-otp
   - Verifies OTP matches
   - Generates magic link or session tokens
   - Returns access_token and refresh_token
   ↓
6. Frontend uses tokens to authenticate as that user
   - Can now access all their period tracking data
```

## API Endpoints

### 1. Check Email
**POST** `/api/login-for-other/check-email`

Checks if the provided email exists in the Supabase Auth system.

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "Account found. OTP will be sent to this email address.",
  "email": "user@example.com"
}
```

**Response (Not Found - 404):**
```json
{
  "error": "No account found with this email address. Please make sure the person has created an account first."
}
```

### 2. Send OTP
**POST** `/api/login-for-other/send-otp`

Generates and sends a 6-digit OTP to the specified email address.

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "OTP has been sent to the email address",
  "expiresIn": 600
}
```

**Note:** Currently, OTPs are logged to the console. For production, configure an email service (see Email Configuration below).

### 3. Verify OTP
**POST** `/api/login-for-other/verify-otp`

Verifies the OTP and returns session tokens for authentication.

**Request:**
```json
{
  "email": "user@example.com",
  "otp": "123456"
}
```

**Response (Success - 200):**
```json
{
  "success": true,
  "message": "OTP verified successfully. You can now access the account.",
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "created_at": "2024-01-01T00:00:00Z"
  },
  "session": {
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "v1.M...="
  },
  "loginLink": "https://mclzuszfbmrqvhrtnzvq.supabase.co/auth/v1/verify?...",
  "tempToken": "abc123...",
  "expiresAt": "2024-01-01T00:15:00Z"
}
```

**Response (Invalid OTP - 400):**
```json
{
  "error": "Invalid OTP code. Please try again."
}
```

**Response (Expired OTP - 400):**
```json
{
  "error": "OTP has expired. Please request a new one."
}
```

### 4. Complete Login (Optional)
**POST** `/api/login-for-other/complete-login`

Optional endpoint to complete login using a temporary token.

**Request:**
```json
{
  "email": "user@example.com",
  "tempToken": "temporary-token-from-verify-otp"
}
```

## Frontend Integration

### Example Implementation

```javascript
// Step 1: Check if email exists
const checkEmail = async (email) => {
  const response = await fetch('http://localhost:3001/api/login-for-other/check-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  return response.json()
}

// Step 2: Send OTP
const sendOTP = async (email) => {
  const response = await fetch('http://localhost:3001/api/login-for-other/send-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  return response.json()
}

// Step 3: Verify OTP and get session
const verifyOTP = async (email, otp) => {
  const response = await fetch('http://localhost:3001/api/login-for-other/verify-otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, otp }),
  })
  const data = await response.json()
  
  if (data.success && data.session) {
    // Store the session tokens
    // Use data.session.access_token for API calls
    // Use data.session.refresh_token to refresh the session
    return data
  }
  
  return data
}
```

## Email Configuration

### Development
Currently, OTPs are logged to the console. Check your server logs to see the OTP.

### Production Setup

1. **Choose an email service** (recommended: Resend)
   ```bash
   npm install resend
   ```

2. **Update `routes/login-for-other.js`**:
   ```javascript
   import { Resend } from 'resend'
   const resend = new Resend(process.env.RESEND_API_KEY)

   async function sendOTPEmail(email, otp) {
     await resend.emails.send({
       from: 'noreply@yourdomain.com',
       to: email,
       subject: 'Login Verification Code - Period Tracker',
       html: `
         <h2>Your Verification Code</h2>
         <p>Your verification code is: <strong>${otp}</strong></p>
         <p>This code expires in 10 minutes.</p>
         <p>If you didn't request this, please ignore this email.</p>
       `,
     })
   }
   ```

3. **Add to `.env`**:
   ```
   RESEND_API_KEY=re_your_api_key_here
   ```

## Security Features

1. **OTP Expiration**: OTPs expire after 10 minutes
2. **One-Time Use**: Each OTP can only be used once
3. **Token Expiration**: Temporary tokens expire after 15 minutes
4. **Email Verification**: Only accounts that exist in Supabase Auth can be accessed
5. **Secure Storage**: OTPs are stored in memory (for production, consider Redis)

## Production Considerations

1. **Use Redis for OTP Storage**: Replace in-memory storage with Redis for scalability
2. **Rate Limiting**: Add rate limiting to prevent OTP spam
3. **Email Service**: Configure a production email service (Resend, SendGrid, etc.)
4. **Monitoring**: Add logging and monitoring for OTP attempts
5. **Audit Trail**: Log all login-for-other attempts for security auditing

## Testing

### Manual Testing Steps

1. Start the server:
   ```bash
   npm run dev
   ```

2. Test check-email:
   ```bash
   curl -X POST http://localhost:3001/api/login-for-other/check-email \
     -H "Content-Type: application/json" \
     -d '{"email":"existing@user.com"}'
   ```

3. Test send-otp:
   ```bash
   curl -X POST http://localhost:3001/api/login-for-other/send-otp \
     -H "Content-Type: application/json" \
     -d '{"email":"existing@user.com"}'
   ```
   Check server logs for the OTP.

4. Test verify-otp:
   ```bash
   curl -X POST http://localhost:3001/api/login-for-other/verify-otp \
     -H "Content-Type: application/json" \
     -d '{"email":"existing@user.com","otp":"123456"}'
   ```

## Troubleshooting

### OTP Not Received
- Check server logs for the OTP (development mode)
- Verify email service is configured (production)
- Check spam folder

### "Invalid OTP" Error
- Ensure OTP is entered within 10 minutes
- Verify OTP hasn't been used already
- Check for typos in OTP entry

### "Email Not Found" Error
- Verify the email exists in Supabase Auth
- Check email is typed correctly (case-insensitive)
- Ensure user has completed signup

## Support

For issues or questions, refer to:
- Backend README: `README.md`
- API Documentation: Server console output or README.md
- Supabase Docs: https://supabase.com/docs
