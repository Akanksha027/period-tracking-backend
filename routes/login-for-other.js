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
 * Send OTP email using Gmail SMTP (free, no domain required)
 * Requires Gmail App Password - see: https://support.google.com/accounts/answer/185833
 */
async function sendOTPEmail(email, otp) {
  const gmailUser = process.env.GMAIL_USER
  const gmailPassword = process.env.GMAIL_APP_PASSWORD

  // Try Gmail SMTP first (free, no domain required)
  console.log('[OTP EMAIL] Checking Gmail SMTP configuration:', {
    hasGmailUser: !!gmailUser,
    hasGmailPassword: !!gmailPassword,
  })

  if (gmailUser && gmailPassword) {
    try {
      console.log('[OTP EMAIL] Attempting to send via Gmail SMTP...')
      const nodemailer = await import('nodemailer')
      
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: gmailUser,
          pass: gmailPassword,
        },
      })

      const mailOptions = {
        from: `"Period Partner" <${gmailUser}>`,
        to: email,
        subject: 'Your Period Partner Verification Code',
        html: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f5f5f5;">
            <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f5f5f5;">
              <tr>
                <td align="center" style="padding: 40px 20px;">
                  <table role="presentation" style="width: 100%; max-width: 600px; border-collapse: collapse; background-color: #ffffff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    <!-- Header -->
                    <tr>
                      <td style="padding: 40px 40px 30px; text-align: center; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px 12px 0 0;">
                        <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600; letter-spacing: -0.5px;">Period Partner</h1>
                        <p style="margin: 8px 0 0; color: rgba(255,255,255,0.9); font-size: 14px;">Your trusted period tracking companion</p>
                      </td>
                    </tr>
                    
                    <!-- Content -->
                    <tr>
                      <td style="padding: 40px 40px 30px;">
                        <h2 style="margin: 0 0 16px; color: #1a1a1a; font-size: 24px; font-weight: 600;">Verification Code</h2>
                        <p style="margin: 0 0 24px; color: #666666; font-size: 16px; line-height: 1.5;">Hello,</p>
                        <p style="margin: 0 0 32px; color: #666666; font-size: 16px; line-height: 1.5;">Someone is requesting to access a Period Partner account associated with this email address. Use the verification code below to complete the login:</p>
                        
                        <!-- OTP Code Box -->
                        <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 32px 0;">
                          <tr>
                            <td align="center" style="padding: 0;">
                              <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; padding: 32px; text-align: center; box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);">
                                <div style="color: #ffffff; font-size: 36px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace; margin: 0;">${otp}</div>
                              </div>
                            </td>
                          </tr>
                        </table>
                        
                        <p style="margin: 32px 0 0; color: #999999; font-size: 14px; line-height: 1.5;">⏰ This code will expire in <strong style="color: #667eea;">10 minutes</strong>.</p>
                        <p style="margin: 16px 0 0; color: #999999; font-size: 14px; line-height: 1.5;">🔒 If you didn't request this code, please ignore this email. Your account remains secure.</p>
                      </td>
                    </tr>
                    
                    <!-- Footer -->
                    <tr>
                      <td style="padding: 30px 40px; background-color: #f9f9f9; border-radius: 0 0 12px 12px; border-top: 1px solid #eeeeee;">
                        <p style="margin: 0 0 8px; color: #999999; font-size: 12px; text-align: center;">This email was sent by Period Partner</p>
                        <p style="margin: 0; color: #cccccc; font-size: 11px; text-align: center;">© ${new Date().getFullYear()} Period Partner. All rights reserved.</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </body>
          </html>
        `,
        text: `Period Partner - Verification Code

Hello,

Someone is requesting to access a Period Partner account associated with this email address. Use the verification code below to complete the login:

${otp}

⏰ This code will expire in 10 minutes.

🔒 If you didn't request this code, please ignore this email. Your account remains secure.

---
© ${new Date().getFullYear()} Period Partner. All rights reserved.`,
      }

      const info = await transporter.sendMail(mailOptions)
      
      console.log('[OTP EMAIL] ✅ Sent successfully via Gmail SMTP. Message ID:', info.messageId)
      return
    } catch (error) {
      console.error('[OTP EMAIL] Gmail SMTP error:', error)
      console.error('[OTP EMAIL] Error details:', {
        message: error?.message,
        code: error?.code,
      })
      // Fall through to other methods
    }
  } else {
    console.log('[OTP EMAIL] ⚠️  Gmail SMTP not configured')
  }

  // Legacy: EmailJS (only works in browser, not server-side)
  const emailjsServiceId = process.env.EMAILJS_SERVICE_ID
  const emailjsTemplateId = process.env.EMAILJS_TEMPLATE_ID
  const emailjsPublicKey = process.env.EMAILJS_PUBLIC_KEY

  console.log('[OTP EMAIL] Checking EmailJS configuration (browser-only, will skip):', {
    hasServiceId: !!emailjsServiceId,
    hasTemplateId: !!emailjsTemplateId,
    hasPublicKey: !!emailjsPublicKey,
  })

  if (emailjsServiceId && emailjsTemplateId && emailjsPublicKey) {
    try {
      console.log('[OTP EMAIL] Attempting to send via EmailJS...')
      // EmailJS uses fetch API for Node.js
      const emailjsUrl = `https://api.emailjs.com/api/v1.0/email/send`
      
      const requestBody = {
        service_id: emailjsServiceId,
        template_id: emailjsTemplateId,
        user_id: emailjsPublicKey,
        template_params: {
          to_email: email,
          otp_code: otp,
          message: `Your verification code is: ${otp}. This code expires in 10 minutes.`,
        },
      }

      console.log('[OTP EMAIL] EmailJS request:', {
        service_id: emailjsServiceId,
        template_id: emailjsTemplateId,
        user_id: emailjsPublicKey ? emailjsPublicKey.substring(0, 10) + '...' : 'missing',
        to_email: email,
      })
      
      const response = await fetch(emailjsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      })

      // Get response text first to handle non-JSON responses
      const responseText = await response.text()
      console.log('[OTP EMAIL] EmailJS raw response:', {
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get('content-type'),
        responseText: responseText.substring(0, 500), // First 500 chars
      })

      let result
      try {
        result = JSON.parse(responseText)
      } catch (parseError) {
        // If response is not JSON, it might be HTML error page or plain text
        console.error('[OTP EMAIL] Failed to parse EmailJS response as JSON:', parseError)
        throw new Error(`EmailJS returned non-JSON response: ${responseText.substring(0, 200)}`)
      }
      
      console.log('[OTP EMAIL] EmailJS parsed response:', result)
      
      if (!response.ok) {
        throw new Error(result.text || result.message || result.error || 'EmailJS API error')
      }

      // EmailJS returns 200 OK with status "success" or "error" in the response
      if (result.status === 'error' || result.text === 'error') {
        throw new Error(result.text || result.message || 'EmailJS returned error status')
      }

      console.log('[OTP EMAIL] ✅ Sent successfully via EmailJS')
      return
    } catch (error) {
      console.error('[OTP EMAIL] EmailJS error:', error)
      console.error('[OTP EMAIL] Error details:', {
        message: error?.message,
        stack: error?.stack,
      })
      // Fall through to Resend or console log
    }
  } else {
    console.log('[OTP EMAIL] ⚠️  EmailJS not configured - missing credentials:', {
      hasServiceId: !!emailjsServiceId,
      hasTemplateId: !!emailjsTemplateId,
      hasPublicKey: !!emailjsPublicKey,
      serviceIdValue: emailjsServiceId ? emailjsServiceId.substring(0, 10) + '...' : 'missing',
      templateIdValue: emailjsTemplateId ? emailjsTemplateId.substring(0, 10) + '...' : 'missing',
      publicKeyValue: emailjsPublicKey ? emailjsPublicKey.substring(0, 10) + '...' : 'missing',
    })
  }

  // Fallback to Resend ONLY if EmailJS is not configured
  // (Don't try Resend if EmailJS credentials exist but failed)
  if (!emailjsServiceId || !emailjsTemplateId || !emailjsPublicKey) {
    console.log('[OTP EMAIL] EmailJS not fully configured, trying Resend fallback...')
    const resendApiKey = process.env.RESEND_API_KEY
    
    if (resendApiKey && !resendApiKey.includes('xxxxxxxx') && resendApiKey !== 're_xxxxxxxxxxxxxxxxxxxxx') {
    try {
      const { Resend } = await import('resend')
      const resend = new Resend(resendApiKey)
      const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev'
      
      const result = await resend.emails.send({
        from: fromEmail,
        to: email,
        subject: 'Login Verification Code - Period Tracker',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Login Verification Code</h2>
            <p>Your verification code for "Login for Someone Else" is:</p>
            <div style="background-color: #f4f4f4; padding: 20px; text-align: center; margin: 20px 0; border-radius: 5px;">
              <h1 style="color: #0066cc; font-size: 32px; margin: 0; letter-spacing: 5px;">${otp}</h1>
            </div>
            <p style="color: #666; font-size: 14px;">This code expires in 10 minutes.</p>
            <p style="color: #666; font-size: 14px;">If you didn't request this code, please ignore this email.</p>
          </div>
        `,
        text: `Your verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, please ignore this email.`,
      })

      if (result.error) {
        if (result.error.statusCode === 403) {
          console.error('[OTP EMAIL] ⚠️  Resend requires domain verification')
        }
        throw new Error(`Resend API error: ${result.error.message}`)
      }
      
      if (result.data) {
        console.log('[OTP EMAIL] ✅ Sent successfully via Resend. Email ID:', result.data.id)
        return
      }
    } catch (error) {
      console.error('[OTP EMAIL] Resend error:', error)
      // Fall through to console log
    }
    }
  } else {
    console.log('[OTP EMAIL] Skipping Resend - EmailJS is configured (even if it failed)')
  }

  // If both fail, log to console (for development/testing)
  console.log('='.repeat(80))
  console.log('[OTP EMAIL - NOT SENT - Email service not configured]')
  console.log(`To: ${email}`)
  console.log(`Subject: Login Verification Code - Period Tracker`)
  console.log(`Your verification code is: ${otp}`)
  console.log(`This code expires in 10 minutes.`)
  console.log('='.repeat(80))
  console.log('⚠️  To enable email sending, configure Gmail SMTP (recommended - free, no domain needed):')
  console.log('   1. Enable 2-Step Verification on your Google Account')
  console.log('   2. Generate App Password: https://myaccount.google.com/apppasswords')
  console.log('   3. Add to Vercel: GMAIL_USER and GMAIL_APP_PASSWORD')
}

/**
 * Helper function to find user by email in Clerk
 */
async function findUserByEmail(email) {
  try {
    // Log original email to detect corruption
    console.log('[Login For Other] ===== START findUserByEmail =====')
    console.log('[Login For Other] Original email received:', email)
    console.log('[Login For Other] Email type:', typeof email)
    console.log('[Login For Other] Email length:', email?.length)
    
    const normalizedEmail = email.toLowerCase().trim()
    console.log('[Login For Other] Normalized email:', normalizedEmail)
    console.log('[Login For Other] Normalized email length:', normalizedEmail.length)
    console.log('[Login For Other] Normalized email bytes:', Buffer.from(normalizedEmail).toString('hex'))
    
    // Verify email format
    if (!normalizedEmail.includes('@')) {
      console.error('[Login For Other] ERROR: Invalid email format - no @ symbol')
      return null
    }
    
    if (!normalizedEmail.includes('.com') && !normalizedEmail.includes('.net') && !normalizedEmail.includes('.org')) {
      console.warn('[Login For Other] WARNING: Unusual email domain format')
    }

    // First, try to find user in our database (Prisma) for faster lookup
    console.log('[Login For Other] Searching in database for email:', normalizedEmail)
    const dbUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    })
    console.log('[Login For Other] Database lookup result:', dbUser ? `Found user ${dbUser.id}` : 'Not found in database')

        // Search for user in Clerk by email
    try {
      // Clerk SDK v4+ emailAddress filter doesn't work reliably, so we'll do manual search
      console.log('[Login For Other] Searching Clerk for email:', normalizedEmail)
      console.log('[Login For Other] Starting manual search (emailAddress filter not reliable in Clerk SDK v4+)')
      try {
        // Get users - Clerk SDK v4+ returns array directly
        const allUsersResponse = await clerk.users.getUserList({ limit: 500 })
        
        // Normalize response
        let allUsers = null
        if (Array.isArray(allUsersResponse)) {
          allUsers = allUsersResponse
        } else if (allUsersResponse?.data && Array.isArray(allUsersResponse.data)) {
          allUsers = allUsersResponse.data
        } else {
          allUsers = []
        }
        
        console.log('[Login For Other] Total users retrieved for manual search:', allUsers.length)
        
        if (allUsers.length > 0) {
          console.log('[Login For Other] Starting manual search through', allUsers.length, 'users')
          
          // Search through users by fetching full details and checking emails
          let matchedUser = null
          for (const user of allUsers) {
            try {
              // Get full user details to access emailAddresses
              const fullUser = await clerk.users.getUser(user.id)
              
              if (fullUser.emailAddresses && fullUser.emailAddresses.length > 0) {
                // Check each email address
                for (const emailObj of fullUser.emailAddresses) {
                  const emailAddr = emailObj?.emailAddress?.toLowerCase()?.trim()
                  console.log('[Login For Other] Checking email:', emailAddr, 'against:', normalizedEmail, 'Match:', emailAddr === normalizedEmail)
                  
                  if (emailAddr === normalizedEmail) {
                    matchedUser = fullUser
                    console.log('[Login For Other] User found via manual search:', {
                      id: fullUser.id,
                      email: emailObj.emailAddress,
                    })
                    break
                  }
                }
              }
              
              if (matchedUser) break
            } catch (userError) {
              // Skip if we can't fetch user details
              continue
            }
          }
          
          console.log('[Login For Other] Manual search completed. Found match:', !!matchedUser)

          if (matchedUser) {
            const userEmail = matchedUser.emailAddresses?.[0]?.emailAddress || normalizedEmail

            // Sync to database if not exists
            if (!dbUser) {
              try {
                await prisma.user.create({
                  data: {
                    email: normalizedEmail,
                    clerkId: matchedUser.id,
                    name: matchedUser.firstName || matchedUser.lastName
                      ? `${matchedUser.firstName || ''} ${matchedUser.lastName || ''}`.trim()
                      : null,
                  },
                })
              } catch (syncError) {
                console.error('[Login For Other] Error syncing user to database:', syncError)
              }
            }

            console.log('[Login For Other] ===== END findUserByEmail - USER FOUND (manual search) =====')
            return {
              id: matchedUser.id,
              email: userEmail,
              clerkId: matchedUser.id,
              firstName: matchedUser.firstName,
              lastName: matchedUser.lastName,
            }
          } else {
            console.log('[Login For Other] No matching user found in Clerk database')
          }
        } else {
          console.log('[Login For Other] No users retrieved from Clerk database')
        }
      } catch (manualSearchError) {
        console.error('[Login For Other] Error in manual search:', manualSearchError)
      }

      console.log('[Login For Other] User not found in Clerk for email:', normalizedEmail)
      console.log('[Login For Other] ===== END findUserByEmail - USER NOT FOUND =====')
      return null
    } catch (clerkError) {
      console.error('[Login For Other] ===== ERROR in Clerk search =====')
      console.error('[Login For Other] Error searching Clerk:', clerkError)
      console.error('[Login For Other] Error type:', clerkError?.constructor?.name || typeof clerkError)
      console.error('[Login For Other] Error message:', clerkError?.message)
      console.error('[Login For Other] Error stack:', clerkError?.stack)
      
      // Check if Clerk client is properly initialized
      try {
        const clerkCheck = clerk
        console.log('[Login For Other] Clerk client check:', {
          isDefined: typeof clerkCheck !== 'undefined',
          hasUsers: typeof clerkCheck?.users !== 'undefined',
          hasGetUserList: typeof clerkCheck?.users?.getUserList === 'function',
        })
      } catch (checkError) {
        console.error('[Login For Other] Error checking Clerk client:', checkError)
      }
      
      console.log('[Login For Other] ===== END findUserByEmail - ERROR =====')
      return null
    }
  } catch (error) {
    console.error('[Login For Other] ===== FATAL ERROR in findUserByEmail =====')
    console.error('[Login For Other] Error finding user:', error)
    console.error('[Login For Other] Error type:', error?.constructor?.name || typeof error)
    console.error('[Login For Other] Error message:', error?.message)
    console.error('[Login For Other] Error stack:', error?.stack)
    console.log('[Login For Other] ===== END findUserByEmail - FATAL ERROR =====')
    return null
  }
}

/**
 * GET /api/login-for-other/get-otp/:email
 * Get the latest OTP for an email (for testing - remove in production)
 */
router.get('/get-otp/:email', async (req, res) => {
  try {
    const { email } = req.params
    const normalizedEmail = email.toLowerCase().trim()

    // Get the latest unverified OTP for this email
    const otpRecord = await prisma.otpCode.findFirst({
      where: {
        email: normalizedEmail,
        verified: false,
        expiresAt: {
          gt: new Date(), // Not expired
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    })

    if (!otpRecord) {
      return res.status(404).json({
        success: false,
        message: 'No active OTP found for this email',
      })
    }

    res.json({
      success: true,
      email: normalizedEmail,
      otp: otpRecord.otp,
      expiresAt: otpRecord.expiresAt,
      createdAt: otpRecord.createdAt,
      warning: '⚠️ This endpoint is for testing only. Remove in production!',
    })
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    })
  }
})

/**
 * GET /api/login-for-other/test-clerk/:userId
 * Test endpoint to search for a specific user by Clerk User ID
 */
router.get('/test-clerk/:userId', async (req, res) => {
  try {
    const { userId } = req.params
    const debug = {
      userId: userId,
      clerkAvailable: false,
      userFound: false,
      userData: null,
      error: null,
    }

    try {
      if (!clerk || !clerk.users) {
        debug.error = 'Clerk client not initialized'
        return res.status(500).json({ success: false, debug })
      }

      debug.clerkAvailable = true

      // Try to get user by ID
      try {
        const user = await clerk.users.getUser(userId)
        debug.userFound = !!user
        if (user) {
          debug.userData = {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            emails: user.emailAddresses?.map(e => e.emailAddress) || [],
            primaryEmail: user.emailAddresses?.[0]?.emailAddress || null,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          }
        }
        res.json({ success: true, debug })
      } catch (getUserError) {
        debug.error = {
          message: getUserError?.message,
          type: getUserError?.constructor?.name,
          statusCode: getUserError?.statusCode,
        }
        res.status(404).json({ success: false, debug })
      }
    } catch (clerkError) {
      debug.error = {
        message: clerkError?.message,
        type: clerkError?.constructor?.name,
      }
      res.status(500).json({ success: false, debug })
    }
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      details: error.message 
    })
  }
})

/**
 * GET /api/login-for-other/test-clerk
 * Test endpoint to verify Clerk connection and list all users
 */
router.get('/test-clerk', async (req, res) => {
  try {
    const debug = {
      clerkAvailable: false,
      clerkError: null,
      usersFound: 0,
      sampleUsers: [],
      allEmails: [],
    }

    try {
      // Check if Clerk client is available
      if (!clerk || !clerk.users) {
        debug.clerkError = 'Clerk client not initialized'
        return res.status(500).json({ success: false, debug })
      }

      debug.clerkAvailable = true

      // Check Clerk environment
      debug.clerkEnv = {
        hasSecretKey: !!process.env.CLERK_SECRET_KEY,
        secretKeyPrefix: process.env.CLERK_SECRET_KEY ? process.env.CLERK_SECRET_KEY.substring(0, 10) + '...' : 'MISSING',
        secretKeyType: process.env.CLERK_SECRET_KEY ? (process.env.CLERK_SECRET_KEY.startsWith('sk_test_') ? 'TEST' : process.env.CLERK_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'UNKNOWN') : 'NONE',
      }

      // Get all users with detailed error handling
      let usersResponse = null
      try {
        usersResponse = await clerk.users.getUserList({ limit: 100 })
        
        // Clerk SDK v4+ returns an array directly, not { data: [...] }
        // Normalize to consistent structure
        let users = null
        if (Array.isArray(usersResponse)) {
          // Response is array directly
          users = { data: usersResponse }
        } else if (usersResponse?.data && Array.isArray(usersResponse.data)) {
          // Response has data property
          users = usersResponse
        } else if (usersResponse?.users && Array.isArray(usersResponse.users)) {
          // Response has users property
          users = { data: usersResponse.users }
        } else {
          // Unknown structure
          users = { data: [] }
        }
        
        debug.apiCall = {
          success: true,
          responseType: typeof usersResponse,
          isArray: Array.isArray(usersResponse),
          normalizedUsersCount: users?.data?.length || 0,
        }
        
        // Store normalized users for processing
        usersResponse = users
      } catch (apiError) {
        debug.apiCall = {
          success: false,
          error: apiError.message,
          errorType: apiError.constructor.name,
          statusCode: apiError.statusCode,
          statusText: apiError.statusText,
          stack: apiError.stack?.substring(0, 500),
        }
        throw apiError
      }

      debug.usersFound = usersResponse?.data?.length || 0
      
      if (usersResponse?.data && usersResponse.data.length > 0) {
        // Extract all emails - need to fetch full user details to get emailAddresses
        for (const user of usersResponse.data.slice(0, 10)) {
          try {
            // Get full user details to access emailAddresses
            const fullUser = await clerk.users.getUser(user.id)
            if (fullUser.emailAddresses && fullUser.emailAddresses.length > 0) {
              fullUser.emailAddresses.forEach(emailObj => {
                if (emailObj?.emailAddress) {
                  debug.allEmails.push(emailObj.emailAddress.toLowerCase().trim())
                }
              })
            }
            
            // Add to sample users
            if (debug.sampleUsers.length < 5) {
              debug.sampleUsers.push({
                id: fullUser.id,
                emails: fullUser.emailAddresses?.map(e => e.emailAddress) || [],
                firstName: fullUser.firstName,
                lastName: fullUser.lastName,
              })
            }
          } catch (userError) {
            // Skip if we can't fetch user details
            console.error(`Error fetching user ${user.id}:`, userError.message)
          }
        }
      } else {
        debug.warning = 'Clerk API call succeeded but returned no users. This might mean: 1) The CLERK_SECRET_KEY is for a different Clerk instance, 2) There are no users in this instance, 3) The API key lacks permissions.'
      }

      res.json({ success: true, debug })
    } catch (clerkError) {
      debug.clerkError = {
        message: clerkError?.message,
        type: clerkError?.constructor?.name,
      }
      res.status(500).json({ success: false, debug })
    }
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      details: error.message 
    })
  }
})

/**
 * POST /api/login-for-other/verify-credentials
 * Verify email exists (password not required for "login for someone else" flow)
 */
router.post('/verify-credentials', async (req, res) => {
  const debug = {
    emailReceived: null,
    emailNormalized: null,
    dbUserFound: false,
    clerkApiCalled: false,
    clerkResponse: null,
    clerkError: null,
    manualSearchResults: null,
    finalResult: null,
  }

  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ 
        error: 'Email is required',
        debug 
      }) 
    }

    debug.emailReceived = email

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim()
    debug.emailNormalized = normalizedEmail

    // Check database first
    try {
      const dbUser = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      })
      debug.dbUserFound = !!dbUser
    } catch (dbError) {
      debug.dbError = dbError.message
    }

    // Try Clerk API - get all users and search manually
    // Note: emailAddress filter may not work in Clerk SDK v4+, so we'll search manually
    let users = null
    try {
      debug.clerkApiCalled = true
      
      // Get all users (Clerk SDK v4+ returns array directly)
      const allUsersResponse = await clerk.users.getUserList({ limit: 500 })
      
      // Normalize response - Clerk returns array directly
      let allUsers = null
      if (Array.isArray(allUsersResponse)) {
        allUsers = allUsersResponse
      } else if (allUsersResponse?.data && Array.isArray(allUsersResponse.data)) {
        allUsers = allUsersResponse.data
      } else {
        allUsers = []
      }
      
      debug.manualSearchResults = {
        totalRetrieved: allUsers.length,
        emailsChecked: [],
      }

      // Search through users by fetching full details and checking emails
      let matchedUser = null
      for (const user of allUsers.slice(0, 100)) { // Limit to first 100 to avoid too many API calls
        try {
          // Get full user details to access emailAddresses
          const fullUser = await clerk.users.getUser(user.id)
          
          if (fullUser.emailAddresses && fullUser.emailAddresses.length > 0) {
            // Check each email address
            for (const emailObj of fullUser.emailAddresses) {
              const emailAddr = emailObj?.emailAddress?.toLowerCase()?.trim()
              
              if (debug.manualSearchResults.emailsChecked.length < 10) {
                debug.manualSearchResults.emailsChecked.push(emailAddr)
              }
              
              if (emailAddr === normalizedEmail) {
                matchedUser = fullUser
                debug.manualSearchResults.matchFound = true
                debug.manualSearchResults.matchedEmail = emailObj.emailAddress
                break
              }
            }
          }
          
          if (matchedUser) break
        } catch (userError) {
          // Skip if we can't fetch user details
          continue
        }
      }

      if (matchedUser) {
        users = { data: [matchedUser] }
      } else {
        debug.manualSearchResults.matchFound = false
      }
    } catch (clerkError) {
      debug.clerkError = {
        message: clerkError?.message,
        type: clerkError?.constructor?.name,
      }
    }

    // Check if user was found in Clerk
    if (users && users.data && users.data.length > 0) {
      const clerkUser = users.data[0]
      const userEmail = clerkUser.emailAddresses?.[0]?.emailAddress || normalizedEmail

        // CRITICAL: Check if this user exists in our database
        // Only 'SELF' users can be viewed by 'OTHER' users
        // For now, we'll use a simple query that works even if userType column doesn't exist yet
        let selfUser = null
        try {
          // Simple query - doesn't reference userType to avoid schema errors
          selfUser = await prisma.user.findUnique({
            where: { email: normalizedEmail },
          })
          
          // If user exists, check userType (only if column exists)
          if (selfUser) {
            // Try to read userType - if column doesn't exist, it will be undefined
            const userType = selfUser.userType
            
            // If userType exists and is 'OTHER', reject (only SELF users can be viewed)
            if (userType === 'OTHER') {
              debug.finalResult = 'USER_IS_OTHER_TYPE'
              return res.status(400).json({
                success: false,
                error: 'This account is a viewer account. Only "Login for Yourself" accounts can be viewed.',
                debug,
              })
            }
            
            // If userType is null/undefined or 'SELF', allow access
            // All existing users (without userType) are treated as SELF
            if (!userType) {
              // Try to update userType to SELF (will fail silently if column doesn't exist)
              try {
                await prisma.user.update({
                  where: { id: selfUser.id },
                  data: { userType: 'SELF' },
                })
                selfUser.userType = 'SELF'
              } catch (updateError) {
                // Column doesn't exist yet - that's okay, continue
                console.log('[Login For Other] userType column may not exist yet:', updateError.message)
                selfUser.userType = 'SELF' // Treat as SELF in memory
              }
            }
          }
        } catch (dbError) {
          console.error('[Login For Other] Database query error:', dbError)
          debug.dbError = {
            message: dbError.message,
            type: dbError.constructor?.name,
          }
          // Continue to check if user was found
        }

        debug.selfUserCheck = {
          found: !!selfUser,
          userId: selfUser?.id,
          userType: selfUser?.userType,
        }

        if (!selfUser) {
          // User exists in Clerk but not in our database as 'SELF' user
          // This means they haven't created a "Login for Yourself" account yet
          debug.finalResult = 'USER_NOT_SELF_USER'
          return res.status(404).json({
            success: false,
            error: 'No account found with this email address. The person must create an account first using "Login for Yourself".',
            debug,
          })
        }
        
        // If userType is null or undefined, treat as SELF (backward compatibility)
        if (!selfUser.userType) {
          selfUser.userType = 'SELF'
        }

        // User exists as 'SELF' - ready for OTP verification
        debug.finalResult = 'SELF_USER_FOUND'
        return res.json({
          success: true,
          message: 'User found and ready for verification',
          email: normalizedEmail,
          userId: selfUser.id,
          clerkId: clerkUser.id,
          debug,
        })
    }

    // User not found in Clerk
    debug.finalResult = 'USER_NOT_FOUND_IN_CLERK'
    return res.status(404).json({
      success: false,
      error: 'No account found with this email address. The person must create an account first using "Login for Yourself".',
      debug,
    })
  } catch (error) {
    debug.finalResult = 'ERROR'
    debug.error = {
      message: error?.message,
      type: error?.constructor?.name,
      stack: error?.stack,
    }
    return res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      details: error.message,
      debug,
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

    const normalizedEmail = email.toLowerCase().trim()

    // CRITICAL: Find the SELF user (the person whose data will be viewed)
    // Only SELF users can be viewed by OTHER users
    // Use simple query that works even if userType column doesn't exist yet
    let selfUser = null
    try {
      selfUser = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      })
      
      if (selfUser) {
        // Check userType if it exists
        if (selfUser.userType === 'OTHER') {
          return res.status(400).json({
            error: 'This account is a viewer account. Only "Login for Yourself" accounts can be viewed.',
          })
        }
        
        // If userType is null/undefined, treat as SELF and try to update
        if (!selfUser.userType) {
          try {
            await prisma.user.update({
              where: { id: selfUser.id },
              data: { userType: 'SELF' },
            })
            selfUser.userType = 'SELF'
          } catch (updateError) {
            // Column doesn't exist yet - that's okay
            console.log('[Login For Other] userType column may not exist yet:', updateError.message)
            selfUser.userType = 'SELF' // Treat as SELF in memory
          }
        }
      }
    } catch (dbError) {
      console.error('[Login For Other] Database query error:', dbError)
      return res.status(500).json({
        error: 'Database error while checking user',
        details: dbError.message,
      })
    }

    if (!selfUser) {
      return res.status(404).json({
        error: 'No account found with this email address. The person must create an account first using "Login for Yourself".',
      })
    }

    // Verify user exists in Clerk (for email sending)
    const clerkUser = await clerk.users.getUser(selfUser.clerkId)
    if (!clerkUser) {
      return res.status(404).json({
        error: 'User account not found in authentication system',
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

    // Store OTP in database - linked to the SELF user
    await prisma.otpCode.create({
      data: {
        email: normalizedEmail, // SELF user's email
        userId: selfUser.id, // SELF user's ID
        otp,
        expiresAt,
        verified: false,
      },
    })

    // Send OTP via email to the SELF user's email
    try {
      await sendOTPEmail(selfUser.email, otp)
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

    console.log('[Login For Other] Verify OTP request:', { email, otp, otpLength: otp?.length })

    if (!email || !otp) {
      console.log('[Login For Other] Missing email or OTP:', { hasEmail: !!email, hasOtp: !!otp })
      return res.status(400).json({ 
        error: 'Email and OTP are required',
        debug: { hasEmail: !!email, hasOtp: !!otp }
      })
    }

    const normalizedEmail = email.toLowerCase().trim()
    console.log('[Login For Other] Searching for OTP with email:', normalizedEmail)

    // Find the OTP record in database
    const otpData = await prisma.otpCode.findFirst({
      where: {
        email: normalizedEmail,
        verified: false,
      },
      orderBy: {
        createdAt: 'desc',
      },
      include: {
        user: true,
      },
    })

    console.log('[Login For Other] OTP record found:', {
      found: !!otpData,
      otpId: otpData?.id,
      otpExpired: otpData ? new Date() > otpData.expiresAt : null,
      otpMatches: otpData ? otpData.otp === otp : null,
    })

    if (!otpData) {
      console.log('[Login For Other] No OTP record found for email:', normalizedEmail)
      return res.status(400).json({
        error: 'Invalid or expired OTP. Please request a new one.',
        debug: { email: normalizedEmail }
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
    console.log('[Login For Other] Comparing OTPs:', {
      storedOtp: otpData.otp,
      providedOtp: otp,
      match: otpData.otp === otp,
      storedType: typeof otpData.otp,
      providedType: typeof otp,
    })
    
    if (otpData.otp !== otp) {
      console.log('[Login For Other] OTP mismatch')
      return res.status(400).json({
        error: 'Invalid OTP code. Please try again.',
        debug: { 
          storedOtpLength: otpData.otp?.length,
          providedOtpLength: otp?.length,
        }
      })
    }

    // Get the SELF user (the person whose data will be viewed)
    const selfUser = otpData.user
    if (!selfUser) {
      return res.status(404).json({ error: 'User not found in database' })
    }

    // Verify this is a SELF user (or null for backward compatibility)
    if (selfUser.userType && selfUser.userType !== 'SELF') {
      return res.status(400).json({ 
        error: 'Invalid account type. Only "Login for Yourself" accounts can be viewed.',
      })
    }
    
    // Update userType to SELF if it's null (migration for existing users)
    if (!selfUser.userType) {
      try {
        await prisma.user.update({
          where: { id: selfUser.id },
          data: { userType: 'SELF' },
        })
        selfUser.userType = 'SELF'
      } catch (updateError) {
        console.error('[Login For Other] Error updating userType:', updateError)
        // Continue anyway - userType will be null but we'll allow access
      }
    }

    if (!selfUser.clerkId) {
      return res.status(404).json({ error: 'User account incomplete' })
    }

    // Get user from Clerk for email verification
    let clerkUser
    try {
      clerkUser = await clerk.users.getUser(selfUser.clerkId)
    } catch (userError) {
      console.error('[Login For Other] Error getting user from Clerk:', userError)
      return res.status(404).json({ error: 'User not found in Clerk' })
    }

    if (!clerkUser) {
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

    // Return SELF user info and temp token for complete-login
    res.json({
      success: true,
      message: 'OTP verified successfully. You can now access the account.',
      selfUser: {
        id: selfUser.id,
        email: selfUser.email,
        clerkId: selfUser.clerkId,
        name: selfUser.name,
      },
      tempToken, // Frontend will use this in complete-login to create OTHER user
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
    const { email, tempToken, viewerIdentifier } = req.body
    // viewerIdentifier: optional identifier for the viewer (e.g., device ID, session ID, or viewer's email)

    if (!email || !tempToken) {
      return res.status(400).json({ error: 'Email and token are required' })
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Verify temporary token from database
    const otpData = await prisma.otpCode.findFirst({
      where: {
        email: normalizedEmail,
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

    // Get the SELF user (whose data will be viewed)
    const selfUser = otpData.user
    if (!selfUser) {
      return res.status(404).json({ error: 'Self user not found' })
    }
    
    // Verify this is a SELF user (or null for backward compatibility)
    if (selfUser.userType && selfUser.userType !== 'SELF') {
      return res.status(400).json({ 
        error: 'Invalid account type. Only "Login for Yourself" accounts can be viewed.',
      })
    }
    
    // Update userType to SELF if it's null (migration for existing users)
    if (!selfUser.userType) {
      try {
        await prisma.user.update({
          where: { id: selfUser.id },
          data: { userType: 'SELF' },
        })
        selfUser.userType = 'SELF'
      } catch (updateError) {
        console.error('[Login For Other] Error updating userType:', updateError)
        // Continue anyway
      }
    }

    // Create or find the OTHER user (viewer)
    // Try to get the viewer's Clerk ID from the request (if they're logged in)
    // The viewer should be logged in with Clerk to access this endpoint
    let viewerClerkId = null
    try {
      // Try to get Clerk ID from authorization header
      const authHeader = req.headers.authorization
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7)
        const jwt = require('jsonwebtoken')
        const decoded = jwt.decode(token, { complete: true })
        if (decoded && decoded.payload && decoded.payload.sub) {
          viewerClerkId = decoded.payload.sub
        }
      }
    } catch (error) {
      console.log('[Login For Other] Could not extract viewer Clerk ID:', error.message)
    }

    // Try to find existing OTHER user for this viewer (by clerkId if available, or by viewedUserId)
    let otherUser = null
    if (viewerClerkId) {
      // First, try to find by clerkId
      otherUser = await prisma.user.findFirst({
        where: {
          clerkId: viewerClerkId,
          userType: 'OTHER',
          viewedUserId: selfUser.id,
        },
      })
    }

    // If not found, try to find any OTHER user viewing this SELF user (without clerkId)
    if (!otherUser) {
      otherUser = await prisma.user.findFirst({
        where: {
          viewedUserId: selfUser.id,
          userType: 'OTHER',
          clerkId: null, // Only get ones without clerkId
        },
        orderBy: {
          createdAt: 'desc', // Get the most recent one
        },
      })
    }

    // If still not found, create a new OTHER user
    if (!otherUser) {
      const viewerEmail = viewerClerkId 
        ? `${normalizedEmail}.viewer.${viewerClerkId}`.toLowerCase()
        : viewerIdentifier 
        ? `${normalizedEmail}.viewer.${viewerIdentifier}`.toLowerCase()
        : `${normalizedEmail}.viewer.${Date.now()}`.toLowerCase()

      otherUser = await prisma.user.create({
        data: {
          email: viewerEmail,
          clerkId: viewerClerkId, // Link to viewer's Clerk ID if available
          userType: 'OTHER',
          viewedUserId: selfUser.id, // Link to the SELF user they're viewing
          name: `Viewer for ${selfUser.email}`,
        },
      })
    } else if (viewerClerkId && !otherUser.clerkId) {
      // Update existing OTHER user with Clerk ID if we have it
      otherUser = await prisma.user.update({
        where: { id: otherUser.id },
        data: {
          clerkId: viewerClerkId,
        },
      })
    }

    // Clean up the OTP record
    await prisma.otpCode.delete({
      where: { id: otpData.id },
    })

    res.json({
      success: true,
      message: 'Login completed successfully. You can now view the account data.',
      viewer: {
        id: otherUser.id,
        userType: 'OTHER',
        viewedUserId: selfUser.id,
        viewedUserEmail: selfUser.email,
      },
      selfUser: {
        id: selfUser.id,
        email: selfUser.email,
        name: selfUser.name,
      },
    })
  } catch (error) {
    console.error('[Login For Other] Complete login error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

export default router
