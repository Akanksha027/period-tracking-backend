import express from 'express'
import { verifyAuth } from '../lib/auth.js'
import prisma from '../lib/prisma.js'

const router = express.Router()

// All routes require authentication
router.use(verifyAuth)

/**
 * GET /api/user
 * Get current user profile
 */
router.get('/', async (req, res) => {
  try {
    // Find or create user in database
    let dbUser = await prisma.user.findUnique({
      where: { supabaseId: req.user.id },
      include: {
        settings: true,
      },
    })

    // If user doesn't exist in database, create them
    if (!dbUser) {
      dbUser = await prisma.user.create({
        data: {
          email: req.user.email,
          supabaseId: req.user.id,
          name: req.user.user_metadata?.name || req.user.user_metadata?.full_name || null,
          settings: {
            create: {},
          },
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
        supabaseId: dbUser.supabaseId,
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

    // Find user in database
    let dbUser = await prisma.user.findUnique({
      where: { supabaseId: req.user.id },
    })

    // If user doesn't exist, create them
    if (!dbUser) {
      dbUser = await prisma.user.create({
        data: {
          email: req.user.email,
          supabaseId: req.user.id,
          name: name || req.user.user_metadata?.name || null,
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
        supabaseId: updatedUser.supabaseId,
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

export default router
