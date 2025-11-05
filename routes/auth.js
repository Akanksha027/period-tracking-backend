import express from 'express'
import { supabase, supabaseAdmin } from '../lib/supabase.js'

const router = express.Router()

/**
 * POST /api/auth/signup
 * Register a new user
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, password, metadata } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' })
    }

    // Sign up the user
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: metadata || {}, // Additional user metadata
      },
    })

    if (error) {
      console.error('[Auth] Signup error:', error)
      return res.status(400).json({ error: error.message })
    }

    if (!data.user) {
      return res.status(400).json({ error: 'Failed to create user' })
    }

    res.status(201).json({
      message: 'User created successfully',
      user: {
        id: data.user.id,
        email: data.user.email,
        email_confirmed_at: data.user.email_confirmed_at,
      },
      session: data.session,
    })
  } catch (error) {
    console.error('[Auth] Signup exception:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * POST /api/auth/login
 * Login a user
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' })
    }

    // Sign in the user
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      console.error('[Auth] Login error:', error)
      return res.status(401).json({ error: error.message })
    }

    if (!data.user || !data.session) {
      return res.status(401).json({ error: 'Login failed' })
    }

    res.json({
      message: 'Login successful',
      user: {
        id: data.user.id,
        email: data.user.email,
        created_at: data.user.created_at,
      },
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        expires_in: data.session.expires_in,
      },
    })
  } catch (error) {
    console.error('[Auth] Login exception:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * POST /api/auth/refresh
 * Refresh an access token
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body

    if (!refresh_token) {
      return res.status(400).json({ error: 'Refresh token is required' })
    }

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token,
    })

    if (error) {
      console.error('[Auth] Refresh error:', error)
      return res.status(401).json({ error: error.message })
    }

    if (!data.session) {
      return res.status(401).json({ error: 'Failed to refresh session' })
    }

    res.json({
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        expires_in: data.session.expires_in,
      },
    })
  } catch (error) {
    console.error('[Auth] Refresh exception:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * POST /api/auth/logout
 * Logout a user (requires auth)
 */
router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' })
    }

    const token = authHeader.substring(7)

    // Sign out the user
    const { error } = await supabase.auth.signOut({ token })

    if (error) {
      console.error('[Auth] Logout error:', error)
      return res.status(400).json({ error: error.message })
    }

    res.json({ message: 'Logout successful' })
  } catch (error) {
    console.error('[Auth] Logout exception:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

/**
 * GET /api/auth/me
 * Get current user (requires auth)
 */
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' })
    }

    const token = authHeader.substring(7)

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid token', details: error?.message })
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        metadata: user.user_metadata,
      },
    })
  } catch (error) {
    console.error('[Auth] Get me exception:', error)
    res.status(500).json({ error: 'Internal server error', details: error.message })
  }
})

export default router
