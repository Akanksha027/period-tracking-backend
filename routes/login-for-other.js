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
 * Send OTP email using EmailJS (free, no domain required)
 * Get credentials from: https://www.emailjs.com/
 */
async function sendOTPEmail(email, otp) {
  const emailjsServiceId = process.env.EMAILJS_SERVICE_ID
  const emailjsTemplateId = process.env.EMAILJS_TEMPLATE_ID
  const emailjsPublicKey = process.env.EMAILJS_PUBLIC_KEY

  // Try EmailJS first (no domain required)
  if (emailjsServiceId && emailjsTemplateId && emailjsPublicKey) {
    try {
      const emailjs = await import('@emailjs/nodejs')
      
      const result = await emailjs.send(
        emailjsServiceId,
        emailjsTemplateId,
        {
          to_email: email,
          otp_code: otp,
          message: `Your verification code is: ${otp}. This code expires in 10 minutes.`,
        },
        {
          publicKey: emailjsPublicKey,
        }
      )

      console.log('[OTP EMAIL] ✅ Sent successfully via EmailJS:', result)
      return
    } catch (error) {
      console.error('[OTP EMAIL] EmailJS error:', error)
      // Fall through to Resend or console log
    }
  }

  // Fallback to Resend if EmailJS not configured
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

  // If both fail, log to console (for development/testing)
  console.log('='.repeat(80))
  console.log('[OTP EMAIL - NOT SENT - Email service not configured]')
  console.log(`To: ${email}`)
  console.log(`Subject: Login Verification Code - Period Tracker`)
  console.log(`Your verification code is: ${otp}`)
  console.log(`This code expires in 10 minutes.`)
  console.log('='.repeat(80))
  console.log('⚠️  To enable email sending, configure EmailJS (recommended - no domain needed):')
  console.log('   1. Go to https://www.emailjs.com/ and sign up (free)')
  console.log('   2. Create an email service (Gmail works)')
  console.log('   3. Create an email template')
  console.log('   4. Add to Vercel: EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY')
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

    // Check if user was found
    if (users && users.data && users.data.length > 0) {
      const clerkUser = users.data[0]
      const userEmail = clerkUser.emailAddresses?.[0]?.emailAddress || normalizedEmail

      debug.finalResult = 'USER_FOUND'
      
      // Sync to database if needed
      try {
        const existingUser = await prisma.user.findUnique({
          where: { email: normalizedEmail },
        })

        if (!existingUser) {
          await prisma.user.create({
            data: {
              email: normalizedEmail,
              clerkId: clerkUser.id,
              name: clerkUser.firstName || clerkUser.lastName
                ? `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim()
                : null,
            },
          })
        }
      } catch (syncError) {
        debug.syncError = syncError.message
      }

      return res.json({
        success: true,
        message: 'User found and ready for verification',
        email: normalizedEmail,
        userId: clerkUser.id,
        debug, // Include debug info in response
      })
    }

    // User not found
    debug.finalResult = 'USER_NOT_FOUND'
    return res.status(404).json({
      success: false,
      error: 'No account found with this email address',
      debug, // Include debug info in 404 response
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
