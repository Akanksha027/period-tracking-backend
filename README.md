# Period Tracker Backend

Backend API for Period Tracker app with Supabase authentication and Prisma ORM.

## Features

- ✅ Supabase authentication integration
- ✅ Prisma ORM for database operations
- ✅ Login for someone else flow (OTP-based)
- ✅ User profile management
- ✅ Express.js REST API
- ✅ Vercel deployment ready

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file in the root directory:

```env
PORT=3001
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
DATABASE_URL=postgresql://postgres.user:[PASSWORD]@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://postgres.user:[PASSWORD]@aws-0-region.pooler.supabase.com:5432/postgres
```

**Important:** Replace `[PASSWORD]` with your actual Supabase database password.

### 3. Setup Prisma

Generate Prisma Client:

```bash
npm run prisma:generate
```

Push the database schema to Supabase:

```bash
npm run prisma:push
```

Or create a migration:

```bash
npm run prisma:migrate
```

### 4. Start Development Server

```bash
npm run dev
```

The server will run on `http://localhost:3001`

## Database Schema

The application uses Prisma with PostgreSQL (Supabase). The schema includes:

- **User** - User profiles linked to Supabase Auth
- **UserSettings** - User preferences (cycle length, reminders, etc.)
- **Period** - Period tracking entries
- **Symptom** - Symptom logging
- **Mood** - Mood tracking
- **Note** - User notes
- **OtpCode** - OTP codes for "login for someone else" flow

See `prisma/schema.prisma` for the complete schema definition.

## API Endpoints

### Authentication

All protected endpoints require a valid Supabase JWT token in the Authorization header:
```
Authorization: Bearer <your-token>
```

### Auth Endpoints

- `POST /api/auth/signup` - Create new account
- `POST /api/auth/login` - Login with email/password
- `POST /api/auth/refresh` - Refresh access token
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user info

### User Endpoints

- `GET /api/user` - Get user profile (protected)
- `PATCH /api/user` - Update user profile (protected)

### Login For Someone Else Endpoints

- `POST /api/login-for-other/check-email` - Check if email exists
- `POST /api/login-for-other/send-otp` - Send OTP to email
- `POST /api/login-for-other/verify-otp` - Verify OTP code
- `POST /api/login-for-other/complete-login` - Complete login with temp token

### Health Check

- `GET /health` - Server health check

## Prisma Commands

- `npm run prisma:generate` - Generate Prisma Client
- `npm run prisma:push` - Push schema changes to database (development)
- `npm run prisma:migrate` - Create and apply migration
- `npm run prisma:studio` - Open Prisma Studio (database GUI)

## Deployment

See `DEPLOYMENT.md` for Vercel deployment instructions.

## Tech Stack

- **Express.js** - Web framework
- **Prisma** - ORM for PostgreSQL
- **Supabase** - Authentication and PostgreSQL database
- **Node.js** - Runtime environment

## Development Notes

### OTP Storage

OTP codes are stored in the database using Prisma. This ensures:
- ✅ Persistence across server restarts (unlike in-memory storage)
- ✅ Works in serverless environments (Vercel)
- ✅ Automatic cleanup of expired OTPs

### User Management

Users are automatically created in the database when they:
- First access a protected endpoint
- Complete the "login for someone else" flow

Users are linked to Supabase Auth via the `supabaseId` field.

## License

ISC
