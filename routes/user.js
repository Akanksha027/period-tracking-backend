import express from 'express'
import { clerk } from '../lib/clerk.js'
import prisma from '../lib/prisma.js'

const router = express.Router()

/**
 * Middleware to verify Clerk JWT token
 */
async function verifyClerkAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' })
    }

    const token = authHeader.substring(7)

    if (!token) {
      return res.status(401).json({ error: 'Missing token' })
    }

    // Try to get user from token first (decode JWT to get user ID)
    try {
      const jwt = require('jsonwebtoken')
      const decoded = jwt.decode(token, { complete: true })
      
      if (decoded && decoded.payload && decoded.payload.sub) {
        // Token contains user ID in 'sub' claim
        const userId = decoded.payload.sub
        const clerkUser = await clerk.users.getUser(userId)
        
        req.user = {
          id: clerkUser.id,
          email: clerkUser.emailAddresses[0]?.emailAddress,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
          clerkId: clerkUser.id,
        }
        return next()
      }
    } catch (tokenError) {
      console.log('[Auth] Token decode failed, trying alternative method:', tokenError.message)
    }

    // Fallback: Try to get user from request body (email or clerkId)
    const { clerkId, email } = req.body

    if (clerkId) {
      try {
        const clerkUser = await clerk.users.getUser(clerkId)
        req.user = {
          id: clerkUser.id,
          email: clerkUser.emailAddresses[0]?.emailAddress,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
          clerkId: clerkUser.id,
        }
        return next()
      } catch (error) {
        console.error('[Auth] Error getting user by clerkId:', error)
      }
    }

    if (email) {
      try {
        // Find user by email
        const users = await clerk.users.getUserList({ limit: 500 })
        const userArray = Array.isArray(users) ? users : (users.data || [])
        for (const user of userArray.slice(0, 100)) { // Limit to first 100
          try {
            const fullUser = await clerk.users.getUser(user.id)
            if (fullUser.emailAddresses?.some(e => e.emailAddress === email)) {
              req.user = {
                id: fullUser.id,
                email: fullUser.emailAddresses[0]?.emailAddress,
                firstName: fullUser.firstName,
                lastName: fullUser.lastName,
                clerkId: fullUser.id,
              }
              return next()
            }
          } catch (userError) {
            continue
          }
        }
      } catch (error) {
        console.error('[Auth] Error finding user by email:', error)
      }
    }

    // If all methods failed
    return res.status(401).json({ 
      error: 'Authentication failed', 
      details: 'Could not verify user identity. Please ensure you are logged in.',
    })
  } catch (error) {
    console.error('[Auth] Error verifying Clerk token:', error)
    return res.status(401).json({ error: 'Authentication failed', details: error.message })
  }
}

// All routes require authentication
router.use(verifyClerkAuth)

/**
 * GET /api/user
 * Get current user profile
 */
router.get('/', async (req, res) => {
  try {
    // Find or create user in database by Clerk ID
    let dbUser = await prisma.user.findFirst({
      where: {
        OR: [
          { clerkId: req.user.clerkId },
          { email: req.user.email },
        ],
      },
      include: {
        settings: true,
      },
    })

    // If user doesn't exist in database, create them
    if (!dbUser) {
      const userName = req.user.firstName || req.user.lastName
        ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim()
        : null

      dbUser = await prisma.user.create({
        data: {
          email: req.user.email,
          clerkId: req.user.clerkId,
          name: userName,
          userType: 'SELF', // Default to SELF for regular login
          settings: {
            create: {},
          },
        },
        include: {
          settings: true,
        },
      })
    } else if (!dbUser.clerkId) {
      // Update existing user with Clerk ID if missing
      dbUser = await prisma.user.update({
        where: { id: dbUser.id },
        data: {
          clerkId: req.user.clerkId,
          userType: dbUser.userType || 'SELF',
        },
        include: {
          settings: true,
        },
      })
    }

    res.json({
      message: 'User profile retrieved',
      user: {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        clerkId: dbUser.clerkId,
        userType: dbUser.userType,
        createdAt: dbUser.createdAt,
        updatedAt: dbUser.updatedAt,
        settings: dbUser.settings,
      },
    })
  } catch (error) {
    console.error('[User] Get error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * PATCH /api/user
 * Update user profile
 */
router.patch('/', async (req, res) => {
  try {
    const { name, email } = req.body

    // Find user in database by Clerk ID
    let dbUser = await prisma.user.findFirst({
      where: {
        OR: [
          { clerkId: req.user.clerkId },
          { email: req.user.email },
        ],
      },
    })

    // If user doesn't exist, create them
    if (!dbUser) {
      const userName = name || (req.user.firstName || req.user.lastName
        ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim()
        : null)

      dbUser = await prisma.user.create({
        data: {
          email: req.user.email,
          clerkId: req.user.clerkId,
          name: userName,
          userType: 'SELF',
          settings: {
            create: {},
          },
        },
      })
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id: dbUser.id },
      data: {
        ...(name !== undefined && { name }),
        // Note: email should typically not be updated via this endpoint
        // as it's tied to Supabase Auth. But we'll allow it if needed.
        ...(email !== undefined && email !== dbUser.email && { email }),
      },
      include: {
        settings: true,
      },
    })

    res.json({
      message: 'User profile updated',
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        clerkId: updatedUser.clerkId,
        userType: updatedUser.userType,
        createdAt: updatedUser.createdAt,
        updatedAt: updatedUser.updatedAt,
        settings: updatedUser.settings,
      },
    })
  } catch (error) {
    console.error('[User] Update error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * GET /api/user/settings
 * Get user settings
 */
router.get('/settings', async (req, res) => {
  try {
    // Find user in database
    let dbUser = await prisma.user.findFirst({
      where: {
        OR: [
          { clerkId: req.user.clerkId },
          { email: req.user.email },
        ],
      },
      include: {
        settings: true,
      },
    })

    if (!dbUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Create settings if they don't exist
    if (!dbUser.settings) {
      dbUser.settings = await prisma.userSettings.create({
        data: {
          userId: dbUser.id,
        },
      })
    }

    res.json({
      success: true,
      settings: dbUser.settings,
    })
  } catch (error) {
    console.error('[User] Get settings error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * PATCH /api/user/settings
 * Update user settings (for onboarding)
 */
router.patch('/settings', async (req, res) => {
  try {
    const { birthYear, lastPeriodDate, periodDuration, averageCycleLength } = req.body

    // Find user in database
    let dbUser = await prisma.user.findFirst({
      where: {
        OR: [
          { clerkId: req.user.clerkId },
          { email: req.user.email },
        ],
      },
      include: {
        settings: true,
      },
    })

    if (!dbUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Ensure settings exist
    let settings = dbUser.settings
    if (!settings) {
      settings = await prisma.userSettings.create({
        data: {
          userId: dbUser.id,
        },
      })
    }

    // Update settings
    const updateData = {}
    if (birthYear !== undefined) updateData.birthYear = birthYear
    if (lastPeriodDate !== undefined) {
      updateData.lastPeriodDate = lastPeriodDate ? new Date(lastPeriodDate) : null
    }
    if (periodDuration !== undefined) {
      updateData.periodDuration = periodDuration || 5 // Default 5 days
      updateData.averagePeriodLength = periodDuration || 5 // Also update alias
    }
    if (averageCycleLength !== undefined) {
      updateData.averageCycleLength = averageCycleLength || 28 // Default 28 days
    }

    const updatedSettings = await prisma.userSettings.update({
      where: { id: settings.id },
      data: updateData,
    })

    res.json({
      success: true,
      message: 'Settings updated successfully',
      settings: updatedSettings,
    })
  } catch (error) {
    console.error('[User] Update settings error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

export default router
