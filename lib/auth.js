import { supabaseAdmin } from './supabase.js'

/**
 * Middleware to verify Supabase JWT token
 * Extracts user information from the token
 */
export async function verifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' })
    }

    const token = authHeader.substring(7)

    if (!token) {
      return res.status(401).json({ error: 'Missing token' })
    }

    // Verify the token using Supabase
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token', details: error?.message })
    }

    // Attach user to request object
    req.user = user

    next()
  } catch (error) {
    console.error('[Auth] Error verifying token:', error)
    return res.status(401).json({ error: 'Authentication failed', details: error.message })
  }
}

/**
 * Get user from request (optional auth)
 */
export async function getUserFromRequest(req) {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return null
    }

    const token = authHeader.substring(7)

    if (!token) {
      return null
    }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token)

    if (error || !user) {
      return null
    }

    return user
  } catch (error) {
    console.error('[Auth] Error getting user:', error)
    return null
  }
}
