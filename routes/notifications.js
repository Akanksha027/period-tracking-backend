import express from 'express'
import jwt from 'jsonwebtoken'
import { clerk } from '../lib/clerk.js'
import prisma from '../lib/prisma.js'

const router = express.Router()

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

    let clerkId = null
    try {
      const decoded = jwt.decode(token, { complete: true }) || jwt.decode(token)
      clerkId = decoded?.payload?.sub || decoded?.sub || null
    } catch (error) {
      console.log('[Notifications] Failed to decode Clerk token:', error?.message)
    }

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
        console.error('[Notifications] Clerk lookup by decoded ID failed:', error?.message)
      }
    }

    const { clerkId: fallbackClerkId, email } = { ...req.body, ...req.query }
    if (fallbackClerkId) {
      try {
        const clerkUser = await clerk.users.getUser(fallbackClerkId)
        req.user = {
          id: clerkUser.id,
          email: clerkUser.emailAddresses[0]?.emailAddress,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
          clerkId: clerkUser.id,
        }
        return next()
      } catch (error) {
        if (email) {
          req.user = {
            id: fallbackClerkId,
            email,
            firstName: null,
            lastName: null,
            clerkId: fallbackClerkId,
          }
          return next()
        }
      }
    }

    return res.status(401).json({ error: 'Authentication failed. Please ensure you are logged in.' })
  } catch (error) {
    console.error('[Notifications] Auth error:', error)
    return res.status(401).json({ error: 'Authentication failed.' })
  }
}

router.use(verifyClerkAuth)

function parseTimezoneOffset(reqBodyValue, headerValue) {
  if (Number.isFinite(reqBodyValue)) {
    return reqBodyValue
  }
  const parsedHeader = parseInt(headerValue, 10)
  if (Number.isFinite(parsedHeader)) {
    return -parsedHeader
  }
  return 0
}

async function resolveDbUser(clerkId, email) {
  if (!clerkId && !email) {
    return null
  }
  return prisma.user.findFirst({
    where: {
      OR: [
        ...(clerkId ? [{ clerkId }] : []),
        ...(email ? [{ email }] : []),
      ],
    },
  })
}

router.post('/register-token', async (req, res) => {
  try {
    const { expoPushToken, deviceType, mode, viewedUserId } = req.body || {}

    if (!expoPushToken || typeof expoPushToken !== 'string') {
      return res.status(400).json({ error: 'expoPushToken is required' })
    }

    const normalizedMode = typeof mode === 'string' ? mode.toUpperCase() : null
    if (!normalizedMode || !['SELF', 'OTHER'].includes(normalizedMode)) {
      return res.status(400).json({ error: 'mode must be SELF or OTHER' })
    }

    const dbUser = await resolveDbUser(req.user?.clerkId, req.user?.email)
    if (!dbUser) {
      return res.status(404).json({ error: 'User record not found' })
    }

    let resolvedViewedUserId = null
    if (normalizedMode === 'OTHER') {
      resolvedViewedUserId = viewedUserId || dbUser.viewedUserId || null
      if (!resolvedViewedUserId) {
        return res.status(400).json({ error: 'viewedUserId is required for OTHER mode' })
      }
    }

    const timezoneOffsetMinutes = parseTimezoneOffset(
      typeof req.body?.timezoneOffsetMinutes === 'number' ? req.body.timezoneOffsetMinutes : null,
      req.headers['x-timezone-offset']
    )

    const pushToken = await prisma.pushToken.upsert({
      where: { expoPushToken },
      update: {
        userId: dbUser.id,
        deviceType: deviceType || 'unknown',
        mode: normalizedMode,
        viewedUserId: resolvedViewedUserId,
        timezoneOffsetMinutes,
        updatedAt: new Date(),
      },
      create: {
        userId: dbUser.id,
        expoPushToken,
        deviceType: deviceType || 'unknown',
        mode: normalizedMode,
        viewedUserId: resolvedViewedUserId,
        timezoneOffsetMinutes,
      },
    })

    return res.json({
      success: true,
      tokenId: pushToken.id,
      mode: pushToken.mode,
      viewedUserId: pushToken.viewedUserId,
      timezoneOffsetMinutes: pushToken.timezoneOffsetMinutes,
    })
  } catch (error) {
    console.error('[Notifications] Failed to register push token:', error)
    return res.status(500).json({ error: 'Failed to register push token', details: error.message })
  }
})

router.delete('/register-token', async (req, res) => {
  try {
    const { expoPushToken } = req.body || {}
    if (!expoPushToken) {
      return res.status(400).json({ error: 'expoPushToken is required' })
    }

    await prisma.pushToken.deleteMany({
      where: {
        expoPushToken,
      },
    })

    return res.json({ success: true })
  } catch (error) {
    console.error('[Notifications] Failed to unregister push token:', error)
    return res.status(500).json({ error: 'Failed to unregister push token', details: error.message })
  }
})

export default router

