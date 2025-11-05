import express from 'express'
import { supabase, supabaseAdmin } from '../lib/supabase.js'
import { clerk } from '../lib/clerk.js'
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
 * Helper function to find user by email in Clerk
 */
async function findUserByEmail(email) {
  try {
    const normalizedEmail = email.toLowerCase().trim()
    console.log('[Login For Other] Finding user by email in Clerk:', normalizedEmail)

    // First, try to find user in our database (Prisma) for faster lookup
    const dbUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    })

    // Search for user in Clerk by email
    try {
      // Clerk API: Get user list and filter by email
      // Note: Clerk doesn't have a direct "getUserByEmail" API, so we use getUserList with email filter
      const users = await clerk.users.getUserList({
        emailAddress: [normalizedEmail],
        limit: 1,
      })

      if (users && users.data && users.data.length > 0) {
        const clerkUser = users.data[0]
        console.log('[Login For Other] User found in Clerk:', clerkUser.id, clerkUser.emailAddresses[0]?.emailAddress)

        // Sync user to database if not exists
        if (!dbUser) {
          try {
            await prisma.user.create({
              data: {
                email: normalizedEmail,
                clerkId: clerkUser.id,
                name: clerkUser.firstName || clerkUser.lastName 
                  ? `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim() 
                  : null,
              },
            })
            console.log('[Login For Other] User synced to database')
          } catch (syncError) {
            console.error('[Login For Other] Error syncing user to database:', syncError)
            // Continue anyway - user exists in Clerk
          }
        }

        return {
          id: clerkUser.id,
          email: clerkUser.emailAddresses[0]?.emailAddress || normalizedEmail,
          clerkId: clerkUser.id,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
        }
      }

      console.log('[Login For Other] User not found in Clerk for email:', normalizedEmail)
      return null
    } catch (clerkError) {
      console.error('[Login For Other] Error searching Clerk:', clerkError)
      return null
    }
  } catch (error) {
    console.error('[Login For Other] Error finding user:', error)
    console.error('[Login For Other] Error stack:', error.stack)
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

    console.log('[Login For Other] Verifying credentials for email:', email)

    // Check if user exists in Supabase Auth
    const user = await findUserByEmail(email)

    if (!user) {
      console.log('[Login For Other] User not found for email:', email)
      return res.status(404).json({
        success: false,
        error: 'No account found with this email address',
      })
    }

    console.log('[Login For Other] User found:', user.id, user.email)

    // Note: Clerk doesn't support backend password verification for security reasons.
    // Password verification must be done on the frontend using Clerk's signIn.create().
    // Here we just verify the user exists in Clerk.
    // The frontend should verify credentials before calling this endpoint.

    // Credentials are valid (user exists in Clerk)
    // Frontend has already verified the password using Clerk
    console.log('[Login For Other] User exists in Clerk - ready for OTP')
    res.json({
      success: true,
      message: 'User found and ready for verification',
      email: email.toLowerCase().trim(),
      userId: user.id,
    })
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
      where: { email: email.toLowerCase() },
    })

    if (!dbUser) {
      dbUser = await prisma.user.create({
        data: {
          email: user.email,
          clerkId: user.clerkId || user.id,
        },
      })
    } else if (!dbUser.clerkId && (user.clerkId || user.id)) {
      // Update existing user with Clerk ID if missing
      dbUser = await prisma.user.update({
        where: { id: dbUser.id },
        data: {
          clerkId: user.clerkId || user.id,
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

    // Get user information from Clerk
    const dbUser = otpData.user
    if (!dbUser || !dbUser.clerkId) {
      return res.status(404).json({ error: 'User not found in database' })
    }

    // Get user from Clerk
    let clerkUser
    try {
      clerkUser = await clerk.users.getUser(dbUser.clerkId)
    } catch (userError) {
      console.error('[Login For Other] Error getting user from Clerk:', userError)
      return res.status(404).json({ error: 'User not found in Clerk' })
    }

    if (!clerkUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    const user = {
      id: clerkUser.id,
      email: clerkUser.emailAddresses[0]?.emailAddress || dbUser.email,
      created_at: clerkUser.createdAt,
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

    // For Clerk, we can't generate magic links from backend
    // The frontend should handle Clerk authentication after OTP verification
    // We'll return the tempToken which the frontend can use to complete the flow
    res.json({
      success: true,
      message: 'OTP verified successfully. You can now access the account.',
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        clerkId: dbUser.clerkId,
      },
      tempToken, // Frontend can use this to complete login
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

    // Get user from Clerk
    const dbUser = otpData.user
    if (!dbUser || !dbUser.clerkId) {
      return res.status(404).json({ error: 'User not found in database' })
    }

    // Get user from Clerk
    let clerkUser
    try {
      clerkUser = await clerk.users.getUser(dbUser.clerkId)
    } catch (userError) {
      return res.status(404).json({ error: 'User not found in Clerk' })
    }

    if (!clerkUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    const user = {
      id: clerkUser.id,
      email: clerkUser.emailAddresses[0]?.emailAddress || dbUser.email,
      created_at: clerkUser.createdAt,
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
