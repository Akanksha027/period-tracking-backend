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

    // For now, we'll accept Clerk user ID or email from the request
    // The frontend should send the Clerk session token in the Authorization header
    // We'll extract user info from the request body or use a simpler approach
    // TODO: Properly verify Clerk session token
    
    // For now, allow the request to pass with user info in body
    // The frontend should send clerkId or email in the request
    const { clerkId, email } = req.body

    if (!clerkId && !email) {
      // Try to get user from token if available
      try {
        // Basic token verification - get user ID from token
        // Clerk tokens are JWT, we can decode the sub claim
        const jwt = require('jsonwebtoken')
        const decoded = jwt.decode(token)
        
        if (decoded && decoded.sub) {
          const clerkUser = await clerk.users.getUser(decoded.sub)
          req.user = {
            id: clerkUser.id,
            email: clerkUser.emailAddresses[0]?.emailAddress,
            firstName: clerkUser.firstName,
            lastName: clerkUser.lastName,
            clerkId: clerkUser.id,
          }
          return next()
        }
      } catch (error) {
        // Continue to alternative method
      }
      
      return res.status(401).json({ error: 'Missing user identification' })
    }

    // Get user from Clerk
    let clerkUser
    if (clerkId) {
      clerkUser = await clerk.users.getUser(clerkId)
    } else if (email) {
      // Find user by email
      const users = await clerk.users.getUserList({ limit: 500 })
      const userArray = Array.isArray(users) ? users : (users.data || [])
      for (const user of userArray) {
        const fullUser = await clerk.users.getUser(user.id)
        if (fullUser.emailAddresses?.some(e => e.emailAddress === email)) {
          clerkUser = fullUser
          break
        }
      }
    }

    if (!clerkUser) {
      return res.status(401).json({ error: 'User not found' })
    }

    // Attach user to request object
    req.user = {
      id: clerkUser.id,
      email: clerkUser.emailAddresses[0]?.emailAddress,
      firstName: clerkUser.firstName,
      lastName: clerkUser.lastName,
      clerkId: clerkUser.id,
    }

    next()
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
