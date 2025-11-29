import express from 'express'
import { clerk } from '../lib/clerk.js'
import jwt from 'jsonwebtoken'
import axios from 'axios'
import prisma from '../lib/prisma.js'

const router = express.Router()

// Middleware to verify Clerk JWT token
async function verifyClerkAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or invalid authorization header' })
        }

        const token = authHeader.substring(7)

        const decoded = jwt.decode(token, { complete: true })
        let userId = decoded?.payload?.sub

        if (userId) {
            const clerkUser = await clerk.users.getUser(userId)
            req.user = {
                id: clerkUser.id,
                email: clerkUser.emailAddresses[0]?.emailAddress,
                clerkId: clerkUser.id,
            }
            return next()
        }

        return res.status(401).json({ error: 'Authentication failed' })
    } catch (error) {
        return res.status(401).json({ error: 'Authentication failed', details: error.message })
    }
}

router.use(verifyClerkAuth)

// Helper function to get database user ID
async function getDbUserId(req) {
    // Check for OTHER users first (viewers take precedence)
    let dbUser = await prisma.user.findFirst({
        where: {
            clerkId: req.user.clerkId,
            userType: 'OTHER',
        },
    })

    // If OTHER user found, return the viewedUserId
    if (dbUser && dbUser.userType === 'OTHER' && dbUser.viewedUserId) {
        return dbUser.viewedUserId
    }

    // If no OTHER user found, check for SELF user
    if (!dbUser) {
        dbUser = await prisma.user.findFirst({
            where: {
                OR: [
                    { clerkId: req.user.clerkId },
                    { email: req.user.email },
                ],
            },
        })
    }

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
 * POST /api/predictions/ai
 * Get AI-powered period predictions from n8n workflow
 */
router.post('/ai', async (req, res) => {
    try {
        const dbUserId = await getDbUserId(req)

        console.log('[AI Predictions] Requesting predictions for user:', dbUserId)

        // Call n8n webhook
        // IMPORTANT: Replace with your actual n8n webhook URL
        const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook-test/hooks/predictions'

        const response = await axios.post(n8nWebhookUrl, {
            user_id: dbUserId
        }, {
            timeout: 60000, // 60 second timeout (AI takes ~45s)
            headers: {
                'Content-Type': 'application/json'
            }
        })

        console.log('[AI Predictions] Received response from n8n')

        return res.json({
            success: true,
            predictions: response.data.predictions,
            model: response.data.model || 'gemini-2.0-flash-exp',
            generated_at: response.data.generated_at
        })
    } catch (error) {
        console.error('[AI Predictions] Error:', error.message)

        if (error.code === 'ECONNREFUSED') {
            return res.status(503).json({
                error: 'AI prediction service unavailable',
                details: 'n8n workflow is not running or webhook URL is incorrect'
            })
        }

        if (error.response) {
            return res.status(error.response.status).json({
                error: 'AI prediction failed',
                details: error.response.data
            })
        }

        return res.status(500).json({
            error: 'Internal server error',
            details: error.message
        })
    }
})

/**
 * GET /api/predictions/static
 * Get static predictions (fallback if AI is unavailable)
 */

// Already configured in predictions.js
router.post('/ai', async (req, res) => {
    const dbUserId = await getDbUserId(req)

    // Call n8n webhook
    const response = await axios.post(
        process.env.N8N_WEBHOOK_URL,
        { user_id: dbUserId }
    )

    return res.json(response.data)
})



router.get('/static', async (req, res) => {
    try {
        const dbUserId = await getDbUserId(req)

        // Get user's period data
        const periods = await prisma.period.findMany({
            where: { userId: dbUserId },
            orderBy: { startDate: 'desc' },
            take: 10
        })

        const settings = await prisma.userSettings.findUnique({
            where: { userId: dbUserId }
        })

        // Simple static calculation (your current method)
        const avgCycleLength = settings?.averageCycleLength || 28
        const avgPeriodLength = settings?.periodDuration || 5

        const lastPeriod = periods[0]
        const nextPeriodDate = lastPeriod
            ? new Date(lastPeriod.startDate.getTime() + avgCycleLength * 24 * 60 * 60 * 1000)
            : null

        return res.json({
            success: true,
            predictions: {
                next_periods: nextPeriodDate ? [
                    {
                        start_date: nextPeriodDate.toISOString().split('T')[0],
                        expected_duration: avgPeriodLength,
                        confidence: periods.length >= 3 ? 0.75 : 0.5
                    }
                ] : [],
                ovulation: nextPeriodDate ? {
                    date: new Date(nextPeriodDate.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
                    confidence: 0.6
                } : null,
                method: 'static'
            }
        })
    } catch (error) {
        console.error('[Static Predictions] Error:', error)
        return res.status(500).json({
            error: 'Internal server error',
            details: error.message
        })
    }
})

export default router
