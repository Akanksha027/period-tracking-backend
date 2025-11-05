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
      // Clerk API: Try multiple approaches to find user by email
      console.log('[Login For Other] Searching Clerk for email:', normalizedEmail)
      
      // Approach 1: Try with emailAddress filter (might not work in all Clerk versions)
      let users = null
      console.log('[Login For Other] Attempting Clerk API call with emailAddress filter')
      console.log('[Login For Other] Filter email being used:', normalizedEmail)
      try {
        const clerkRequest = {
          emailAddress: [normalizedEmail],
          limit: 1,
        }
        console.log('[Login For Other] Clerk request params:', JSON.stringify(clerkRequest, null, 2))
        
        users = await clerk.users.getUserList(clerkRequest)
        
        console.log('[Login For Other] Clerk API response received')
        console.log('[Login For Other] Response type:', typeof users)
        console.log('[Login For Other] Response keys:', users ? Object.keys(users) : 'null')
        
        const summary = {
          hasData: !!users?.data,
          dataLength: users?.data?.length || 0,
          totalCount: users?.totalCount || 0,
          hasMore: users?.hasMore || false,
        }
        
        if (users?.data?.length > 0) {
          const firstUser = users.data[0]
          summary.firstUserId = firstUser.id
          summary.firstUserEmails = firstUser.emailAddresses?.map(e => e.emailAddress) || []
          summary.firstUserEmail = firstUser.emailAddresses?.[0]?.emailAddress || 'none'
        }
        
        console.log('[Login For Other] Clerk API response summary:', JSON.stringify(summary, null, 2))
        
        // Also log the raw response (truncated if too long)
        if (users) {
          try {
            const responseStr = JSON.stringify(users, null, 2)
            if (responseStr.length > 2000) {
              console.log('[Login For Other] Full Clerk response (first 2000 chars):', responseStr.substring(0, 2000))
              console.log('[Login For Other] Full Clerk response (last 500 chars):', responseStr.substring(responseStr.length - 500))
            } else {
              console.log('[Login For Other] Full Clerk response:', responseStr)
            }
          } catch (jsonError) {
            console.error('[Login For Other] Error stringifying Clerk response:', jsonError)
            console.log('[Login For Other] Clerk response (raw):', users)
          }
        } else {
          console.log('[Login For Other] Clerk API returned null or undefined')
        }
      } catch (filterError) {
        console.error('[Login For Other] Clerk API call failed with error')
        console.error('[Login For Other] Error type:', filterError?.constructor?.name || typeof filterError)
        console.error('[Login For Other] Error message:', filterError?.message)
        console.error('[Login For Other] Error stack:', filterError?.stack)
        console.log('[Login For Other] EmailAddress filter failed, trying without filter')
        users = null
      }

      // If emailAddress filter worked, check results
      if (users && users.data && users.data.length > 0) {
        const clerkUser = users.data[0]
        const userEmail = clerkUser.emailAddresses?.[0]?.emailAddress || normalizedEmail
        console.log('[Login For Other] User found in Clerk:', {
          id: clerkUser.id,
          email: userEmail,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
        })

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

        console.log('[Login For Other] ===== END findUserByEmail - USER FOUND (emailAddress filter) =====')
        return {
          id: clerkUser.id,
          email: userEmail,
          clerkId: clerkUser.id,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
        }
      }

      // Try alternative: search without email filter and manually filter
      console.log('[Login For Other] Email filter didn\'t work, trying manual search')
      try {
        // Get users in batches to find the one with matching email
        let allUsers = await clerk.users.getUserList({ limit: 500 })
        console.log('[Login For Other] Total users retrieved for manual search:', allUsers?.data?.length || 0)
        
        if (allUsers?.data && allUsers.data.length > 0) {
          console.log('[Login For Other] Starting manual search through', allUsers.data.length, 'users')
          // Search through all emails (primary and secondary)
          let checkedCount = 0
          const matchedUser = allUsers.data.find(user => {
            if (!user.emailAddresses || user.emailAddresses.length === 0) return false
            return user.emailAddresses.some(emailObj => {
              const emailAddr = emailObj?.emailAddress?.toLowerCase()?.trim()
              checkedCount++
              if (checkedCount <= 5 || emailAddr === normalizedEmail) {
                console.log('[Login For Other] Checking email:', emailAddr, 'against:', normalizedEmail, 'Match:', emailAddr === normalizedEmail)
              }
              return emailAddr === normalizedEmail
            })
          })
          console.log('[Login For Other] Manual search completed. Checked', checkedCount, 'email addresses. Found match:', !!matchedUser)

          if (matchedUser) {
            const userEmail = matchedUser.emailAddresses?.[0]?.emailAddress || normalizedEmail
            console.log('[Login For Other] User found via manual search:', {
              id: matchedUser.id,
              email: userEmail,
            })

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
      let users = null
      try {
        users = await clerk.users.getUserList({ limit: 100 })
        
        // Log the full response structure
        debug.apiCall = {
          success: true,
          responseType: typeof users,
          responseIsNull: users === null,
          responseIsUndefined: users === undefined,
          responseKeys: users ? Object.keys(users) : [],
          hasData: !!users?.data,
          dataType: Array.isArray(users?.data) ? 'array' : typeof users?.data,
          totalCount: users?.totalCount,
          hasMore: users?.hasMore,
          // Try to see what the actual response looks like
          responsePreview: users ? JSON.stringify(users).substring(0, 500) : 'null',
        }
        
        // If users.data doesn't exist, try alternative response structures
        if (!users?.data && users) {
          // Maybe it's a different structure - check if it's an array directly
          if (Array.isArray(users)) {
            debug.alternativeStructure = 'Response is array directly'
            users = { data: users }
          } else if (users.users && Array.isArray(users.users)) {
            debug.alternativeStructure = 'Response has users property'
            users = { data: users.users }
          } else if (users.items && Array.isArray(users.items)) {
            debug.alternativeStructure = 'Response has items property'
            users = { data: users.items }
          }
        }
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

      debug.usersFound = users?.data?.length || 0
      
      if (users?.data && users.data.length > 0) {
        // Extract all emails
        users.data.forEach(user => {
          if (user.emailAddresses && user.emailAddresses.length > 0) {
            user.emailAddresses.forEach(emailObj => {
              if (emailObj?.emailAddress) {
                debug.allEmails.push(emailObj.emailAddress.toLowerCase().trim())
              }
            })
          }
        })

        // Sample first 5 users
        debug.sampleUsers = users.data.slice(0, 5).map(user => ({
          id: user.id,
          emails: user.emailAddresses?.map(e => e.emailAddress) || [],
          firstName: user.firstName,
          lastName: user.lastName,
        }))
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

    // Try Clerk API with emailAddress filter
    let users = null
    try {
      debug.clerkApiCalled = true
      users = await clerk.users.getUserList({
        emailAddress: [normalizedEmail],
        limit: 1,
      })
      debug.clerkResponse = {
        hasData: !!users?.data,
        dataLength: users?.data?.length || 0,
        totalCount: users?.totalCount || 0,
        firstUserEmails: users?.data?.[0]?.emailAddresses?.map(e => e.emailAddress) || [],
      }
    } catch (clerkError) {
      debug.clerkError = {
        message: clerkError?.message,
        type: clerkError?.constructor?.name,
      }
    }

    // If emailAddress filter didn't work, try manual search
    if (!users || !users.data || users.data.length === 0) {
      try {
        const allUsers = await clerk.users.getUserList({ limit: 500 })
        debug.manualSearchResults = {
          totalRetrieved: allUsers?.data?.length || 0,
          emailsChecked: [],
        }

        if (allUsers?.data) {
          const matchedUser = allUsers.data.find(user => {
            if (!user.emailAddresses || user.emailAddresses.length === 0) return false
            return user.emailAddresses.some(emailObj => {
              const emailAddr = emailObj?.emailAddress?.toLowerCase()?.trim()
              if (debug.manualSearchResults.emailsChecked.length < 10) {
                debug.manualSearchResults.emailsChecked.push(emailAddr)
              }
              return emailAddr === normalizedEmail
            })
          })

          if (matchedUser) {
            users = { data: [matchedUser] }
            debug.manualSearchResults.matchFound = true
            debug.manualSearchResults.matchedEmail = matchedUser.emailAddresses?.[0]?.emailAddress
          } else {
            debug.manualSearchResults.matchFound = false
          }
        }
      } catch (manualError) {
        debug.manualSearchError = manualError.message
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
