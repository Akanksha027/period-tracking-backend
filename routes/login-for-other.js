import express from 'express'
import { supabase, supabaseAdmin } from '../lib/supabase.js'
import prisma from '../lib/prisma.js'
import crypto from 'crypto'

const router = express.Router()

// Clean up expired OTPs every 5 minutes
// Only run in non-serverless environments (local development)
if (typeof process !== 'undefined' && process.env.VERCEL !== '1' && !process.env.VERCEL_ENV) {
  setInterval(async () => {
    try {
      const now = new Date()
      await prisma.otpCode.deleteMany({
        where: {
          expiresAt: {
            lt: now,
          },
        },
      })
    } catch (error) {
      console.error('[Login For Other] Error cleaning up expired OTPs:', error)
    }
  }, 5 * 60 * 1000)
}

/**
 * Generate 6-digit OTP
 */
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

/**
 * Send OTP email (mock implementation - replace with actual email service)
 * In production, use Resend, SendGrid, AWS SES, or Supabase's email service
 */
async function sendOTPEmail(email, otp) {
  // TODO: Replace with actual email service
  console.log('='.repeat(80))
  console.log('[OTP EMAIL]')
  console.log(`To: ${email}`)
  console.log(`Subject: Login Verification Code - Period Tracker`)
  console.log(`Your verification code is: ${otp}`)
  console.log(`This code expires in 10 minutes.`)
  console.log(`If you didn't request this, please ignore this email.`)
  console.log('='.repeat(80))
  
  // For now, we'll use Supabase's built-in email function if available
  // Or integrate with a service like Resend:
  // const resend = new Resend(process.env.RESEND_API_KEY)
  // await resend.emails.send({
  //   from: 'noreply@yourdomain.com',
  //   to: email,
  //   subject: 'Login Verification Code',
  //   html: `<p>Your verification code is: <strong>${otp}</strong></p>`
  // })
}

/**
 * Helper function to find user by email
 */
async function findUserByEmail(email) {
  try {
    const normalizedEmail = email.toLowerCase().trim()

    // First, try to find user in our database (Prisma)
    // This is faster and more reliable than querying Supabase Auth
    const dbUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    })

    if (dbUser && dbUser.supabaseId) {
      // User exists in database, get from Supabase Auth
      try {
        const { data: { user }, error: getUserError } = await supabaseAdmin.auth.admin.getUserById(dbUser.supabaseId)
        if (!getUserError && user) {
          return user
        }
      } catch (getUserError) {
        console.error('[Login For Other] Error getting user by ID:', getUserError)
        // Continue to fallback method
      }
    }

    // Fallback: Search Supabase Auth directly
    // Use listUsers and search through pages if needed
    let page = 1
    const perPage = 1000
    let hasMore = true

    while (hasMore) {
      const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage,
      })

      if (error) {
        console.error('[Login For Other] Error listing users:', error)
        break
      }

      if (!users || users.length === 0) {
        hasMore = false
        break
      }

      // Search for user with matching email
      const user = users.find(u => {
        const userEmail = u.email?.toLowerCase().trim()
        return userEmail === normalizedEmail
      })

      if (user) {
        return user
      }

      // If we got fewer users than perPage, we've reached the end
      if (users.length < perPage) {
        hasMore = false
      } else {
        page++
      }
    }

    return null
  } catch (error) {
    console.error('[Login For Other] Error finding user:', error)
    return null
  }
}

/**
 * POST /api/login-for-other/verify-credentials
 * Verify email and password credentials
 */
router.post('/verify-credentials', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    // Check if user exists in Supabase Auth
    const user = await findUserByEmail(email)

    if (!user) {
      return res.status(404).json({
        error: 'No account found with this email address',
      })
    }

    // Verify password by attempting to sign in
    try {
      const { data: authData, error: signInError } = await supabaseAdmin.auth.signInWithPassword({
        email: email.toLowerCase(),
        password,
      })

      if (signInError || !authData.user) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password',
        })
      }

      // Credentials are valid
      res.json({
        success: true,
        message: 'Credentials verified successfully',
        email: email.toLowerCase(),
      })
    } catch (authError) {
      console.error('[Login For Other] Auth error:', authError)
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      })
    }
  } catch (error) {
    console.error('[Login For Other] Verify credentials error:', error)
    res.status(500).json({ 
      success: false,
      error: 'Internal server error', 
      details: error.message 
    })
  }
})

/**
 * POST /api/login-for-other/check-email
 * Check if email exists in the system
 */
router.post('/check-email', async (req, res) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    // Check if user exists in Supabase Auth
    const user = await findUserByEmail(email)

    if (!user) {
      return res.status(404).json({
        error: 'No account found with this email address. Please make sure the person has created an account first.',
      })
    }

    // Return success - email exists
    res.json({
      success: true,
      message: 'Account found. OTP will be sent to this email address.',
      email: email.toLowerCase(),
    })
  } catch (error) {
    console.error('[Login For Other] Check email error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * POST /api/login-for-other/send-otp
 * Send OTP to the email address
 */
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    // Check if user exists in Supabase Auth
    const user = await findUserByEmail(email)

    if (!user) {
      return res.status(404).json({
        error: 'No account found with this email address',
      })
    }

    // Find or create user in database
    let dbUser = await prisma.user.findUnique({
      where: { supabaseId: user.id },
    })

    if (!dbUser) {
      dbUser = await prisma.user.create({
        data: {
          email: user.email,
          supabaseId: user.id,
        },
      })
    }

    // Generate OTP
    const otp = generateOTP()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes from now

    // Delete any existing unverified OTPs for this email
    await prisma.otpCode.deleteMany({
      where: {
        email: email.toLowerCase(),
        verified: false,
      },
    })

    // Store OTP in database
    await prisma.otpCode.create({
      data: {
        email: email.toLowerCase(),
        userId: dbUser.id,
        otp,
        expiresAt,
        verified: false,
      },
    })

    // Send OTP via email
    try {
      await sendOTPEmail(user.email, otp)
    } catch (emailError) {
      console.error('[Login For Other] Email sending error:', emailError)
      // Continue anyway - OTP is still created
    }

    res.json({
      success: true,
      message: 'OTP has been sent to the email address',
      expiresIn: 600, // 10 minutes in seconds
    })
  } catch (error) {
    console.error('[Login For Other] Send OTP error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * POST /api/login-for-other/verify-otp
 * Verify OTP and create a session for the user
 */
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' })
    }

    // Find the OTP record in database
    const otpData = await prisma.otpCode.findFirst({
      where: {
        email: email.toLowerCase(),
        verified: false,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        user: true,
      },
    })

    if (!otpData) {
      return res.status(400).json({
        error: 'Invalid or expired OTP. Please request a new one.',
      })
    }

    // Check if OTP has expired
    if (new Date() > otpData.expiresAt) {
      await prisma.otpCode.delete({
        where: { id: otpData.id },
      })
      return res.status(400).json({
        error: 'OTP has expired. Please request a new one.',
      })
    }

    // Check if OTP matches
    if (otpData.otp !== otp) {
      return res.status(400).json({
        error: 'Invalid OTP code. Please try again.',
      })
    }

    // Get user information from Supabase Auth
    const dbUser = otpData.user
    if (!dbUser || !dbUser.supabaseId) {
      return res.status(404).json({ error: 'User not found in database' })
    }

    const { data: { user }, error: userError } = await supabaseAdmin.auth.admin.getUserById(dbUser.supabaseId)

    if (userError || !user) {
      console.error('[Login For Other] Error getting user:', userError)
      return res.status(404).json({ error: 'User not found' })
    }

    // Generate a temporary token
    const tempToken = crypto.randomBytes(32).toString('hex')
    const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes

    // Update OTP record with verification and temp token
    await prisma.otpCode.update({
      where: { id: otpData.id },
      data: {
        verified: true,
        tempToken,
        tempTokenExpiresAt: tokenExpiresAt,
      },
    })

    // Clean up old verified OTPs (older than 1 hour)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    await prisma.otpCode.deleteMany({
      where: {
        verified: true,
        createdAt: {
          lt: oneHourAgo,
        },
      },
    })

    // Generate a magic link that the client can use to authenticate
    // This allows the person logging in for someone else to get a session
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: user.email,
      options: {
        redirectTo: `${process.env.FRONTEND_URL || 'period-tracker://'}/auth/callback`,
      },
    })

    if (linkError) {
      console.error('[Login For Other] Error generating link:', linkError)
      // Fallback: create a session token manually using JWT
      // We'll create a custom JWT token that the client can use
      return res.json({
        success: true,
        message: 'OTP verified successfully',
        user: {
          id: user.id,
          email: user.email,
          created_at: user.created_at,
        },
        tempToken, // Client can use this to complete login via complete-login endpoint
        expiresAt: tokenExpiresAt,
      })
    }

    // Extract the token from the magic link
    const magicLinkUrl = new URL(linkData.properties.action_link)
    const hash = magicLinkUrl.hash.substring(1) // Remove # 
    const params = new URLSearchParams(hash)
    const accessToken = params.get('access_token')
    const refreshToken = params.get('refresh_token')

    res.json({
      success: true,
      message: 'OTP verified successfully. You can now access the account.',
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
      },
      session: accessToken && refreshToken ? {
        access_token: accessToken,
        refresh_token: refreshToken,
      } : null,
      loginLink: linkData.properties.action_link, // Fallback: use magic link
      tempToken, // Backup method
      expiresAt: tokenExpiresAt,
    })
  } catch (error) {
    console.error('[Login For Other] Verify OTP error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * POST /api/login-for-other/complete-login
 * Complete the login process using the temporary token
 */
router.post('/complete-login', async (req, res) => {
  try {
    const { email, tempToken } = req.body

    if (!email || !tempToken) {
      return res.status(400).json({ error: 'Email and token are required' })
    }

    // Verify temporary token from database
    const otpData = await prisma.otpCode.findFirst({
      where: {
        email: email.toLowerCase(),
        tempToken,
        verified: true,
      },
      include: {
        user: true,
      },
    })

    if (!otpData) {
      return res.status(400).json({ error: 'Invalid or expired token' })
    }

    // Check if token has expired
    if (!otpData.tempTokenExpiresAt || new Date() > otpData.tempTokenExpiresAt) {
      await prisma.otpCode.delete({
        where: { id: otpData.id },
      })
      return res.status(400).json({ error: 'Token has expired. Please verify OTP again.' })
    }

    // Get user from Supabase Auth
    const dbUser = otpData.user
    if (!dbUser || !dbUser.supabaseId) {
      return res.status(404).json({ error: 'User not found in database' })
    }

    const { data: { user }, error: userError } = await supabaseAdmin.auth.admin.getUserById(dbUser.supabaseId)

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Clean up the OTP record
    await prisma.otpCode.delete({
      where: { id: otpData.id },
    })

    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
      },
      // Client should use the login link from verify-otp response
    })
  } catch (error) {
    console.error('[Login For Other] Complete login error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

export default router
