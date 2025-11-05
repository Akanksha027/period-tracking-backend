import express from 'express'
import { clerk } from '../lib/clerk.js'
import prisma from '../lib/prisma.js'
import jwt from 'jsonwebtoken'

const router = express.Router()

/**
 * Middleware to verify Clerk JWT token (reused from user.js)
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

    // Try to decode JWT token to get user ID
    try {
      let decoded = jwt.decode(token, { complete: true })
      let userId = null
      
      if (decoded && decoded.payload && decoded.payload.sub) {
        userId = decoded.payload.sub
      } else {
        decoded = jwt.decode(token)
        if (decoded && decoded.sub) {
          userId = decoded.sub
        }
      }
      
      if (userId) {
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
      console.log('[Periods Auth] Token decode failed, trying alternative method')
    }

    // Fallback: Try to get user from request body or query params
    const { clerkId, email } = { ...req.body, ...req.query }

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
        console.error('[Periods Auth] Error getting user by clerkId:', error)
      }
    }

    if (email) {
      try {
        const users = await clerk.users.getUserList({ limit: 500 })
        const userArray = Array.isArray(users) ? users : (users.data || [])
        for (const user of userArray.slice(0, 100)) {
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
        console.error('[Periods Auth] Error finding user by email:', error)
      }
    }

    return res.status(401).json({ 
      error: 'Authentication failed', 
      details: 'Could not verify user identity. Please ensure you are logged in.',
    })
  } catch (error) {
    console.error('[Periods Auth] Error verifying Clerk token:', error)
    return res.status(401).json({ error: 'Authentication failed', details: error.message })
  }
}

// All routes require authentication
router.use(verifyClerkAuth)

/**
 * Helper function to get user's database ID
 */
async function getDbUserId(req) {
  // Find or create user in database
  let dbUser = await prisma.user.findFirst({
    where: {
      OR: [
        { clerkId: req.user.clerkId },
        { email: req.user.email },
      ],
    },
  })

  if (!dbUser) {
    const userName = req.user.firstName || req.user.lastName
      ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim()
      : null

    dbUser = await prisma.user.create({
      data: {
        email: req.user.email,
        clerkId: req.user.clerkId,
        name: userName,
        userType: 'SELF',
      },
    })
  }

  return dbUser.id
}

/**
 * GET /api/periods
 * Get all periods for the authenticated user
 */
router.get('/', async (req, res) => {
  try {
    const dbUserId = await getDbUserId(req)

    const periods = await prisma.period.findMany({
      where: { userId: dbUserId },
      orderBy: { startDate: 'desc' },
    })

    res.json({
      success: true,
      periods: periods.map(p => ({
        id: p.id,
        startDate: p.startDate.toISOString(),
        endDate: p.endDate?.toISOString() || null,
        flowLevel: p.flowLevel,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      })),
    })
  } catch (error) {
    console.error('[Periods] Get error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * POST /api/periods
 * Create a new period
 */
router.post('/', async (req, res) => {
  try {
    const { startDate, endDate, flowLevel } = req.body

    if (!startDate) {
      return res.status(400).json({ error: 'startDate is required' })
    }

    const dbUserId = await getDbUserId(req)

    const period = await prisma.period.create({
      data: {
        userId: dbUserId,
        startDate: new Date(startDate),
        endDate: endDate ? new Date(endDate) : null,
        flowLevel: flowLevel || null,
      },
    })

    res.json({
      success: true,
      period: {
        id: period.id,
        startDate: period.startDate.toISOString(),
        endDate: period.endDate?.toISOString() || null,
        flowLevel: period.flowLevel,
        createdAt: period.createdAt.toISOString(),
        updatedAt: period.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('[Periods] Create error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * PATCH /api/periods/:id
 * Update a period
 */
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { startDate, endDate, flowLevel } = req.body

    const dbUserId = await getDbUserId(req)

    // Verify period belongs to user
    const existingPeriod = await prisma.period.findFirst({
      where: {
        id,
        userId: dbUserId,
      },
    })

    if (!existingPeriod) {
      return res.status(404).json({ error: 'Period not found' })
    }

    const updateData = {}
    if (startDate !== undefined) updateData.startDate = new Date(startDate)
    if (endDate !== undefined) updateData.endDate = endDate ? new Date(endDate) : null
    if (flowLevel !== undefined) updateData.flowLevel = flowLevel

    const period = await prisma.period.update({
      where: { id },
      data: updateData,
    })

    res.json({
      success: true,
      period: {
        id: period.id,
        startDate: period.startDate.toISOString(),
        endDate: period.endDate?.toISOString() || null,
        flowLevel: period.flowLevel,
        createdAt: period.createdAt.toISOString(),
        updatedAt: period.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('[Periods] Update error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * DELETE /api/periods/:id
 * Delete a period
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const dbUserId = await getDbUserId(req)

    // Verify period belongs to user
    const existingPeriod = await prisma.period.findFirst({
      where: {
        id,
        userId: dbUserId,
      },
    })

    if (!existingPeriod) {
      return res.status(404).json({ error: 'Period not found' })
    }

    await prisma.period.delete({
      where: { id },
    })

    res.json({
      success: true,
      message: 'Period deleted successfully',
    })
  } catch (error) {
    console.error('[Periods] Delete error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

export default router

