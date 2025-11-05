import express from 'express'
import { supabase, supabaseAdmin } from '../lib/supabase.js'
import crypto from 'crypto'

const router = express.Router()

// In-memory OTP storage (in production, use Redis or database)
// Format: { email: { otp: string, expiresAt: Date, verified: boolean } }
const otpStore = new Map()

// Clean up expired OTPs every 5 minutes
setInterval(() => {
  const now = new Date()
  for (const [email, data] of otpStore.entries()) {
    if (now > data.expiresAt) {
      otpStore.delete(email)
    }
  }
}, 5 * 60 * 1000)

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
    // Use Supabase Admin API to get user by email
    // Note: listUsers with email filter would be ideal, but if not available,
    // we'll use getUserById after finding via listUsers (less efficient but works)
    const { data: { users }, error } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1000, // Adjust as needed
    })

    if (error) {
      console.error('[Login For Other] Error listing users:', error)
      return null
    }

    const user = users.find(u => u.email?.toLowerCase() === email.toLowerCase())
    return user || null
  } catch (error) {
    console.error('[Login For Other] Error finding user:', error)
    return null
  }
}

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

    // Generate OTP
    const otp = generateOTP()
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000) // 10 minutes from now

    // Delete any existing unverified OTPs for this email
    const existing = otpStore.get(email.toLowerCase())
    if (existing && !existing.verified) {
      otpStore.delete(email.toLowerCase())
    }

    // Store OTP
    otpStore.set(email.toLowerCase(), {
      otp,
      expiresAt,
      verified: false,
      userId: user.id,
      createdAt: new Date(),
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

    // Find the OTP record
    const otpData = otpStore.get(email.toLowerCase())

    if (!otpData) {
      return res.status(400).json({
        error: 'Invalid or expired OTP. Please request a new one.',
      })
    }

    // Check if OTP has expired
    if (new Date() > otpData.expiresAt) {
      otpStore.delete(email.toLowerCase())
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

    // Check if already verified
    if (otpData.verified) {
      return res.status(400).json({
        error: 'This OTP has already been used. Please request a new one.',
      })
    }

    // Mark OTP as verified
    otpData.verified = true

    // Get user information
    const { data: { user }, error: userError } = await supabaseAdmin.auth.admin.getUserById(otpData.userId)

    if (userError || !user) {
      console.error('[Login For Other] Error getting user:', userError)
      return res.status(404).json({ error: 'User not found' })
    }

    // Create a magic link token or password reset token to get a session
    // Since we can't directly create a session for another user, we'll generate a one-time token
    // The client will use this token to sign in as that user
    // For security, we'll create a short-lived token that can be used once

    // Generate a temporary token (in production, store this in database with expiration)
    const tempToken = crypto.randomBytes(32).toString('hex')
    const tokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes

    // Store temporary token (in production, use Redis or database)
    otpData.tempToken = tempToken
    otpData.tempTokenExpiresAt = tokenExpiresAt

    // Clean up old verified OTPs (older than 1 hour)
    for (const [emailKey, data] of otpStore.entries()) {
      if (data.verified && new Date() > new Date(data.createdAt.getTime() + 60 * 60 * 1000)) {
        otpStore.delete(emailKey)
      }
    }

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

    // Verify temporary token
    const otpData = otpStore.get(email.toLowerCase())

    if (!otpData || !otpData.tempToken || otpData.tempToken !== tempToken) {
      return res.status(400).json({ error: 'Invalid or expired token' })
    }

    // Check if token has expired
    if (new Date() > otpData.tempTokenExpiresAt) {
      otpStore.delete(email.toLowerCase())
      return res.status(400).json({ error: 'Token has expired. Please verify OTP again.' })
    }

    // Get user and create a session
    const { data: { user }, error: userError } = await supabaseAdmin.auth.admin.getUserById(otpData.userId)

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Generate a new session token
    // Note: Supabase admin API doesn't directly create sessions
    // We'll need to use a password reset or magic link approach
    // For now, we'll return user info and the client can handle the session creation

    // Clean up the temporary token
    delete otpData.tempToken
    delete otpData.tempTokenExpiresAt

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
