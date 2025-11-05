import express from 'express'
import { verifyAuth } from '../lib/auth.js'

const router = express.Router()

// All routes require authentication
router.use(verifyAuth)

/**
 * GET /api/user
 * Get current user profile
 */
router.get('/', async (req, res) => {
  try {
    res.json({
      message: 'User profile retrieved',
      user: {
        id: req.user.id,
        email: req.user.email,
        created_at: req.user.created_at,
        metadata: req.user.user_metadata,
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
    const { metadata } = req.body

    // Here you can update user metadata in Supabase
    // For now, we'll just return the current user
    res.json({
      message: 'User profile updated',
      user: {
        id: req.user.id,
        email: req.user.email,
        metadata: metadata || req.user.user_metadata,
      },
    })
  } catch (error) {
    console.error('[User] Update error:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

export default router
