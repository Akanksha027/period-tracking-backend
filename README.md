# Period Tracker Backend

A Node.js/Express backend API for the Period Tracker app, using Supabase for authentication and database.

## Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Configure environment variables:**
   - Create a `.env` file in the root directory
   - Copy the values from `.env.example` and fill in your Supabase credentials
   - Make sure to replace `[YOUR-PASSWORD]` with your actual Supabase database password

3. **Run the development server:**
```bash
npm run dev
```

The server will start on `http://localhost:3001` (or the port specified in your `.env` file).

## API Endpoints

### Authentication Endpoints

#### POST `/api/auth/signup`
Register a new user.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "metadata": {} // optional
}
```

**Response:**
```json
{
  "message": "User created successfully",
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "email_confirmed_at": null
  },
  "session": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_at": 1234567890
  }
}
```

#### POST `/api/auth/login`
Login a user.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "message": "Login successful",
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "created_at": "2024-01-01T00:00:00Z"
  },
  "session": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_at": 1234567890,
    "expires_in": 3600
  }
}
```

#### POST `/api/auth/refresh`
Refresh an access token.

**Request Body:**
```json
{
  "refresh_token": "your-refresh-token"
}
```

#### POST `/api/auth/logout`
Logout a user (requires authentication).

**Headers:**
```
Authorization: Bearer <access_token>
```

#### GET `/api/auth/me`
Get current user information (requires authentication).

**Headers:**
```
Authorization: Bearer <access_token>
```

### User Endpoints

All user endpoints require authentication via Bearer token.

#### GET `/api/user`
Get current user profile.

**Headers:**
```
Authorization: Bearer <access_token>
```

#### PATCH `/api/user`
Update user profile.

**Headers:**
```
Authorization: Bearer <access_token>
```

**Request Body:**
```json
{
  "metadata": {
    "name": "John Doe",
    "age": 25
  }
}
```

### Health Check

#### GET `/health`
Check if the server is running.

### Login For Someone Else Endpoints

These endpoints allow someone to log in on behalf of another user using email and OTP verification.

#### POST `/api/login-for-other/check-email`
Check if an email exists in the system.

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Account found. OTP will be sent to this email address.",
  "email": "user@example.com"
}
```

#### POST `/api/login-for-other/send-otp`
Send OTP to the email address for verification.

**Request Body:**
```json
{
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP has been sent to the email address",
  "expiresIn": 600
}
```

#### POST `/api/login-for-other/verify-otp`
Verify the OTP and get a session token.

**Request Body:**
```json
{
  "email": "user@example.com",
  "otp": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP verified successfully. You can now access the account.",
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "created_at": "2024-01-01T00:00:00Z"
  },
  "session": {
    "access_token": "...",
    "refresh_token": "..."
  },
  "loginLink": "https://...",
  "tempToken": "...",
  "expiresAt": "2024-01-01T00:15:00Z"
}
```

#### POST `/api/login-for-other/complete-login`
Complete the login process using a temporary token (optional endpoint).

**Request Body:**
```json
{
  "email": "user@example.com",
  "tempToken": "temporary-token"
}
```

## Authentication Flow

1. **Sign Up:** User registers with email and password
2. **Login:** User logs in and receives access_token and refresh_token
3. **API Requests:** Include the access_token in the Authorization header:
   ```
   Authorization: Bearer <access_token>
   ```
4. **Token Refresh:** When the access_token expires, use the refresh_token to get a new access_token
5. **Logout:** Invalidate the session

## Environment Variables

Required environment variables:

- `PORT` - Server port (default: 3001)
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Your Supabase anonymous/public key
- `SUPABASE_SERVICE_ROLE_KEY` - Your Supabase service role key (for server-side operations)
- `DATABASE_URL` - PostgreSQL connection string (for Prisma, if using)
- `DIRECT_URL` - Direct PostgreSQL connection string (for migrations)

## Tech Stack

- **Node.js** - Runtime environment
- **Express** - Web framework
- **Supabase** - Authentication and database
- **CORS** - Cross-origin resource sharing
- **dotenv** - Environment variable management

## Development

Run the server in development mode with auto-reload:
```bash
npm run dev
```

Run the server in production mode:
```bash
npm start
```

## Notes

- All authentication endpoints use Supabase Auth
- Protected routes require a valid JWT token in the Authorization header
- Tokens are verified server-side using Supabase Admin client
- The service role key is used for server-side token verification (never expose this key to clients)

### Email Service Configuration

The login-for-other flow requires email sending for OTP delivery. Currently, OTPs are logged to the console for development. For production, you need to:

1. **Set up an email service** (recommended options):
   - **Resend** (https://resend.com) - Simple and developer-friendly
   - **SendGrid** (https://sendgrid.com) - Robust email delivery
   - **AWS SES** (https://aws.amazon.com/ses/) - Enterprise-grade
   - **Supabase Email Templates** - If configured in Supabase dashboard

2. **Install the email service package**, for example with Resend:
   ```bash
   npm install resend
   ```

3. **Update the `sendOTPEmail` function** in `routes/login-for-other.js` to use your email service.

4. **Add email service credentials** to your `.env` file:
   ```
   RESEND_API_KEY=your_resend_api_key
   # OR
   SENDGRID_API_KEY=your_sendgrid_api_key
   ```

### Login For Someone Else Flow

1. User clicks "Login for someone else" and enters the target user's email
2. Backend checks if the email exists in Supabase Auth (`/api/login-for-other/check-email`)
3. If email exists, send OTP to that email (`/api/login-for-other/send-otp`)
4. User enters the OTP they received
5. Backend verifies OTP and returns session tokens (`/api/login-for-other/verify-otp`)
6. Frontend uses the session tokens to access the account

**Important Security Notes:**
- OTPs expire after 10 minutes
- Each OTP can only be used once
- Temporary tokens expire after 15 minutes
- OTP storage is in-memory (for production, consider using Redis or database)
