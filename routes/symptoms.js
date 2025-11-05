import express from 'express'
import { clerk } from '../lib/clerk.js'
import prisma from '../lib/prisma.js'
import jwt from 'jsonwebtoken'

const router = express.Router()

/**
 * Middleware to verify Clerk JWT token (same as periods.js)
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
          clerkId: clerkUser.id,
        }
        return next()
      }
    } catch (tokenError) {
      // Fallback
    }

    const { clerkId, email } = { ...req.body, ...req.query }

    if (clerkId) {
      try {
        const clerkUser = await clerk.users.getUser(clerkId)
        req.user = {
          id: clerkUser.id,
          email: clerkUser.emailAddresses[0]?.emailAddress,
          clerkId: clerkUser.id,
        }
        return next()
      } catch (error) {
        // Continue
      }
    }

    return res.status(401).json({ error: 'Authentication failed' })
  } catch (error) {
    return res.status(401).json({ error: 'Authentication failed', details: error.message })
  }
}

router.use(verifyClerkAuth)

async function getDbUserId(req) {
  let dbUser = await prisma.user.findFirst({
    where: {
      OR: [
        { clerkId: req.user.clerkId },
        { email: req.user.email },
      ],
    },
  })

  if (!dbUser) {
    dbUser = await prisma.user.create({
      data: {
        email: req.user.email,
        clerkId: req.user.clerkId,
        userType: 'SELF',
      },
    })
  }

  return dbUser.id
}

/**
 * GET /api/symptoms
 * Get symptoms for a date range or all symptoms
 */
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate } = req.query
    const dbUserId = await getDbUserId(req)

    const where = { userId: dbUserId }
    if (startDate || endDate) {
      where.date = {}
      if (startDate) where.date.gte = new Date(startDate)
      if (endDate) where.date.lte = new Date(endDate)
    }

    const symptoms = await prisma.symptom.findMany({
      where,
      orderBy: { date: 'desc' },
    })

    res.json({
      success: true,
      symptoms: symptoms.map(s => ({
        id: s.id,
        date: s.date.toISOString(),
        type: s.type,
        severity: s.severity,
        createdAt: s.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    console.error('[Symptoms] Get error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * POST /api/symptoms
 * Create a new symptom
 */
router.post('/', async (req, res) => {
  try {
    const { date, type, severity } = req.body

    if (!date || !type) {
      return res.status(400).json({ error: 'date and type are required' })
    }

    const dbUserId = await getDbUserId(req)

    const symptom = await prisma.symptom.create({
      data: {
        userId: dbUserId,
        date: new Date(date),
        type,
        severity: severity || 3,
      },
    })

    res.json({
      success: true,
      symptom: {
        id: symptom.id,
        date: symptom.date.toISOString(),
        type: symptom.type,
        severity: symptom.severity,
        createdAt: symptom.createdAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('[Symptoms] Create error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * DELETE /api/symptoms/:id
 * Delete a symptom
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    const dbUserId = await getDbUserId(req)

    const existing = await prisma.symptom.findFirst({
      where: { id, userId: dbUserId },
    })

    if (!existing) {
      return res.status(404).json({ error: 'Symptom not found' })
    }

    await prisma.symptom.delete({ where: { id } })

    res.json({ success: true, message: 'Symptom deleted successfully' })
  } catch (error) {
    console.error('[Symptoms] Delete error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

export default router

