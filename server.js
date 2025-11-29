import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import authRoutes from './routes/auth.js'
import userRoutes from './routes/user.js'
import loginForOtherRoutes from './routes/login-for-other.js'
import periodsRoutes from './routes/periods.js'
import symptomsRoutes from './routes/symptoms.js'
import moodsRoutes from './routes/moods.js'
import chatRoutes from './routes/chat.js'
import reminderRoutes from './routes/reminders.js'
import predictionsRoutes from './routes/predictions.js'
import notificationRoutes from './routes/notifications.js'

// Verify chat route is loaded
if (!chatRoutes) {
  console.error('[Server] ERROR: Chat routes failed to load!')
} else {
  console.log('[Server] Chat routes module loaded successfully')
}

// Load environment variables
dotenv.config()

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Request logging middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
  next()
})

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Period Tracker Backend API',
    version: '1.0.0',
    status: 'ok',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      auth: {
        signup: 'POST /api/auth/signup',
        login: 'POST /api/auth/login',
        refresh: 'POST /api/auth/refresh',
        logout: 'POST /api/auth/logout',
        me: 'GET /api/auth/me',
      },
      user: {
        get: 'GET /api/user',
        update: 'PATCH /api/user',
      },
      loginForOther: {
        verifyCredentials: 'POST /api/login-for-other/verify-credentials',
        checkEmail: 'POST /api/login-for-other/check-email',
        sendOtp: 'POST /api/login-for-other/send-otp',
        verifyOtp: 'POST /api/login-for-other/verify-otp',
        completeLogin: 'POST /api/login-for-other/complete-login',
      },
      chat: {
        chat: 'POST /api/chat',
      },
      reminders: {
        generate: 'POST /api/reminders/generate',
        status: 'GET /api/reminders/status',
        test: 'GET /api/reminders/test?email=your-email@example.com',
      },
      notifications: {
        register: 'POST /api/notifications/register-token',
        unregister: 'DELETE /api/notifications/register-token',
      },
    },
  })
})

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// API Routes
app.use('/api/auth', authRoutes)
app.use('/api/user', userRoutes)
app.use('/api/login-for-other', loginForOtherRoutes)
app.use('/api/periods', periodsRoutes)
app.use('/api/symptoms', symptomsRoutes)
app.use('/api/moods', moodsRoutes)
app.use('/api/chat', chatRoutes)
app.use('/api/reminders', reminderRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/predictions', predictionsRoutes)

// Log that chat route is registered
console.log('[Server] Chat route registered at /api/chat')
console.log('[Server] Reminder routes registered at /api/reminders')
console.log('[Server] Notification routes registered at /api/notifications')

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// Error handler
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err)
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  })
})

// Only start server if not in Vercel/serverless environment
if (process.env.VERCEL !== '1' && !process.env.VERCEL_ENV) {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`)
    console.log(`📝 API endpoints:`)
    console.log(`   POST   /api/auth/signup`)
    console.log(`   POST   /api/auth/login`)
    console.log(`   POST   /api/auth/refresh`)
    console.log(`   POST   /api/auth/logout`)
    console.log(`   GET    /api/auth/me`)
    console.log(`   GET    /api/user`)
    console.log(`   PATCH  /api/user`)
    console.log(`   POST   /api/login-for-other/verify-credentials`)
    console.log(`   POST   /api/login-for-other/check-email`)
    console.log(`   POST   /api/login-for-other/send-otp`)
    console.log(`   POST   /api/login-for-other/verify-otp`)
    console.log(`   POST   /api/login-for-other/complete-login`)
    console.log(`   GET    /health`)
  })
}

export default app
