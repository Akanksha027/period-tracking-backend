import express from 'express'
import { GoogleGenerativeAI } from '@google/generative-ai'
import prisma from '../lib/prisma.js'
import { clerk } from '../lib/clerk.js'
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

    try {
      let decoded = jwt.decode(token, { complete: true })
      let userId = null
      
      if (decoded && decoded.payload && decoded.payload.sub) {
        userId = decoded.payload.sub
      } else if (decoded && decoded.sub) {
        userId = decoded.sub
      } else {
        decoded = jwt.decode(token)
        if (decoded && decoded.sub) {
          userId = decoded.sub
        }
      }
      
      if (userId) {
        try {
          const clerkUser = await clerk.users.getUser(userId)
          
          req.user = {
            id: clerkUser.id,
            email: clerkUser.emailAddresses[0]?.emailAddress,
            firstName: clerkUser.firstName,
            lastName: clerkUser.lastName,
            clerkId: clerkUser.id,
          }
          return next()
        } catch (userError) {
          console.error('[Reminder Auth] Error getting user from Clerk:', userError.message)
        }
      }
    } catch (tokenError) {
      console.log('[Reminder Auth] Token decode failed:', tokenError.message)
    }

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
        console.error('[Reminder Auth] Error getting user by clerkId:', error)
      }
    }

    return res.status(401).json({ error: 'Unauthorized' })
  } catch (error) {
    console.error('[Reminder Auth] Error:', error)
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

/**
 * Helper function to find user by Clerk ID
 */
async function findUserByClerkId(clerkId) {
  try {
    const user = await prisma.user.findFirst({
      where: { clerkId },
    })
    return user
  } catch (error) {
    console.error('[Reminder] Error finding user:', error)
    return null
  }
}

/**
 * Get Gemini client
 */
function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured')
  }
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
}

/**
 * Calculate current cycle day and phase
 */
function calculateCycleInfo(periods, settings, today) {
  if (!periods || periods.length === 0) {
    return null
  }

  const userPeriodLength = settings?.periodDuration || settings?.averagePeriodLength || 5
  const avgCycleLength = settings?.averageCycleLength || 28

  // Get last period
  const lastPeriod = periods[0]
  const lastPeriodStart = new Date(lastPeriod.startDate)
  lastPeriodStart.setHours(0, 0, 0, 0)

  let lastPeriodEnd = new Date(lastPeriodStart)
  if (lastPeriod.endDate) {
    lastPeriodEnd = new Date(lastPeriod.endDate)
  } else {
    lastPeriodEnd.setDate(lastPeriodEnd.getDate() + userPeriodLength - 1)
  }
  lastPeriodEnd.setHours(0, 0, 0, 0)

  // Check if currently on period
  const activePeriod = periods.find(period => {
    const start = new Date(period.startDate)
    const startLocal = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    startLocal.setHours(0, 0, 0, 0)

    let endLocal = null
    if (period.endDate) {
      const end = new Date(period.endDate)
      endLocal = new Date(end.getFullYear(), end.getMonth(), end.getDate())
      endLocal.setHours(0, 0, 0, 0)
    } else {
      endLocal = new Date(startLocal)
      endLocal.setDate(endLocal.getDate() + userPeriodLength - 1)
    }

    return startLocal <= today && endLocal >= today
  })

  if (activePeriod) {
    const periodStart = new Date(activePeriod.startDate)
    const periodStartLocal = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate())
    periodStartLocal.setHours(0, 0, 0, 0)

    const diff = Math.floor((today.getTime() - periodStartLocal.getTime()) / (1000 * 60 * 60 * 24))
    const daysInPeriod = diff + 1

    return {
      cycleDay: daysInPeriod,
      phase: 'Menstrual',
      phaseDescription: `Day ${daysInPeriod} of period`,
      isOnPeriod: true,
    }
  }

  // Calculate days since last period ended
  const daysSinceLastPeriodEnd = Math.floor((today.getTime() - lastPeriodEnd.getTime()) / (1000 * 60 * 60 * 24))

  if (daysSinceLastPeriodEnd >= 0) {
    const currentCycleDay = daysSinceLastPeriodEnd + 1 + userPeriodLength

    // Determine phase
    const ovulationDay = Math.round(avgCycleLength / 2)
    const fertileStart = ovulationDay - 5
    const fertileEnd = ovulationDay

    let phase = 'Follicular'
    if (currentCycleDay >= fertileStart && currentCycleDay <= fertileEnd) {
      phase = 'Ovulation'
    } else if (currentCycleDay > fertileEnd) {
      phase = 'Luteal'
    }

    return {
      cycleDay: currentCycleDay,
      phase,
      phaseDescription: `Day ${currentCycleDay} of ${avgCycleLength}-day cycle (${phase} Phase)`,
      isOnPeriod: false,
    }
  }

  return null
}

/**
 * POST /api/reminders/generate - Generate AI reminder for a user
 */
router.post('/generate', verifyClerkAuth, async (req, res) => {
  try {
    const dbUser = await findUserByClerkId(req.user.clerkId)
    
    if (!dbUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Check if reminders are enabled
    const settings = await prisma.userSettings.findUnique({
      where: { userId: dbUser.id },
    })

    if (!settings || !settings.reminderEnabled) {
      return res.json({ 
        success: false, 
        message: 'Reminders are disabled',
        reminder: null 
      })
    }

    // Fetch user data
    const dbUserWithData = await prisma.user.findUnique({
      where: { id: dbUser.id },
      include: {
        settings: true,
        periods: {
          orderBy: { startDate: 'desc' },
          take: 6,
        },
        symptoms: {
          where: {
            date: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
              lt: new Date(new Date().setHours(23, 59, 59, 999)),
            },
          },
        },
        moods: {
          where: {
            date: {
              gte: new Date(new Date().setHours(0, 0, 0, 0)),
              lt: new Date(new Date().setHours(23, 59, 59, 999)),
            },
          },
        },
      },
    })

    if (!dbUserWithData) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Check if user has period data
    if (!dbUserWithData.periods || dbUserWithData.periods.length === 0) {
      return res.json({ 
        success: false, 
        message: 'No period data available for reminders',
        reminder: null 
      })
    }

    // Calculate cycle info
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const cycleInfo = calculateCycleInfo(dbUserWithData.periods, dbUserWithData.settings, today)

    if (!cycleInfo) {
      return res.json({ 
        success: false, 
        message: 'Unable to calculate cycle information',
        reminder: null 
      })
    }

    // Build context for AI
    const userName = dbUserWithData.name || req.user.firstName || 'there'
    const todaySymptoms = dbUserWithData.symptoms.map(s => s.type).join(', ') || 'none'
    const todayMoods = dbUserWithData.moods.map(m => m.type).join(', ') || 'none'

    const context = `
User: ${userName}
Current Phase: ${cycleInfo.phase}
Cycle Day: ${cycleInfo.cycleDay}
Phase Description: ${cycleInfo.phaseDescription}
Today's Symptoms: ${todaySymptoms}
Today's Moods: ${todayMoods}
Average Cycle Length: ${dbUserWithData.settings?.averageCycleLength || 28} days
Average Period Length: ${dbUserWithData.settings?.periodDuration || dbUserWithData.settings?.averagePeriodLength || 5} days
`

    // Generate reminder using AI
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'AI service is not configured' })
    }

    const genAI = getGeminiClient()
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' })

    const prompt = `You are a supportive and caring period health assistant. Generate a personalized reminder message for a user based on their cycle phase and today's mood/symptoms.

${context}

Generate a short, warm, and supportive reminder message (2-3 sentences max) that includes:
1. A brief acknowledgment of their current cycle phase
2. A motivational or supportive message tailored to their phase
3. A helpful tip or knowledge based on their phase and today's mood/symptoms

The message should be:
- Warm, supportive, and empathetic
- Phase-appropriate (mention their phase if relevant)
- Consider their mood today (if they're feeling down, be extra supportive)
- Include one practical tip or knowledge
- Keep it concise (2-3 sentences)

Generate ONLY the reminder message, no additional text or explanations.`

    const result = await model.generateContent(prompt)
    const response = await result.response
    const reminderText = response.text().trim()

    // Save reminder to database (optional - for tracking)
    const reminder = await prisma.reminder.create({
      data: {
        userId: dbUser.id,
        message: reminderText,
        phase: cycleInfo.phase,
        cycleDay: cycleInfo.cycleDay,
        sentAt: new Date(),
      },
    })

    return res.json({
      success: true,
      reminder: {
        id: reminder.id,
        message: reminderText,
        phase: cycleInfo.phase,
        cycleDay: cycleInfo.cycleDay,
        sentAt: reminder.sentAt,
      },
    })
  } catch (error) {
    console.error('[Reminder Generate] Error:', error)
    return res.status(500).json({ 
      error: 'Failed to generate reminder',
      details: error.message 
    })
  }
})

/**
 * GET /api/reminders/status - Get reminder status for user
 */
router.get('/status', verifyClerkAuth, async (req, res) => {
  try {
    const dbUser = await findUserByClerkId(req.user.clerkId)
    
    if (!dbUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    const settings = await prisma.userSettings.findUnique({
      where: { userId: dbUser.id },
    })

    // Get last reminder sent
    const lastReminder = await prisma.reminder.findFirst({
      where: { userId: dbUser.id },
      orderBy: { sentAt: 'desc' },
    })

    return res.json({
      enabled: settings?.reminderEnabled || false,
      lastReminder: lastReminder ? {
        id: lastReminder.id,
        message: lastReminder.message,
        sentAt: lastReminder.sentAt,
      } : null,
    })
  } catch (error) {
    console.error('[Reminder Status] Error:', error)
    return res.status(500).json({ error: 'Failed to get reminder status' })
  }
})

/**
 * GET /api/reminders/test - Test endpoint (for development only)
 * This allows testing without authentication
 */
router.get('/test', async (req, res) => {
  try {
    // For testing, accept email as query parameter
    const { email } = req.query

    if (!email) {
      return res.status(400).json({ 
        error: 'Email parameter required for testing',
        example: '/api/reminders/test?email=your-email@example.com'
      })
    }

    // Find user by email
    const dbUser = await prisma.user.findFirst({
      where: { email },
      include: {
        settings: true,
        periods: {
          orderBy: { startDate: 'desc' },
          take: 6,
        },
      },
    })

    if (!dbUser) {
      return res.status(404).json({ error: `User not found with email: ${email}` })
    }

    // Check if reminders are enabled
    if (!dbUser.settings || !dbUser.settings.reminderEnabled) {
      return res.json({ 
        success: false, 
        message: 'Reminders are disabled for this user',
        reminder: null 
      })
    }

    // Get today's symptoms and moods
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)

    const [symptoms, moods] = await Promise.all([
      prisma.symptom.findMany({
        where: {
          userId: dbUser.id,
          date: {
            gte: today,
            lt: tomorrow,
          },
        },
      }),
      prisma.mood.findMany({
        where: {
          userId: dbUser.id,
          date: {
            gte: today,
            lt: tomorrow,
          },
        },
      }),
    ])

    // Calculate cycle info
    const userPeriodLength = dbUser.settings?.periodDuration || dbUser.settings?.averagePeriodLength || 5
    const avgCycleLength = dbUser.settings?.averageCycleLength || 28

    if (!dbUser.periods || dbUser.periods.length === 0) {
      return res.json({ 
        success: false, 
        message: 'No period data available for reminders',
        reminder: null 
      })
    }

    const lastPeriod = dbUser.periods[0]
    const lastPeriodStart = new Date(lastPeriod.startDate)
    lastPeriodStart.setHours(0, 0, 0, 0)

    let lastPeriodEnd = new Date(lastPeriodStart)
    if (lastPeriod.endDate) {
      lastPeriodEnd = new Date(lastPeriod.endDate)
    } else {
      lastPeriodEnd.setDate(lastPeriodEnd.getDate() + userPeriodLength - 1)
    }
    lastPeriodEnd.setHours(0, 0, 0, 0)

    const activePeriod = dbUser.periods.find(period => {
      const start = new Date(period.startDate)
      const startLocal = new Date(start.getFullYear(), start.getMonth(), start.getDate())
      startLocal.setHours(0, 0, 0, 0)

      let endLocal = null
      if (period.endDate) {
        const end = new Date(period.endDate)
        endLocal = new Date(end.getFullYear(), end.getMonth(), end.getDate())
        endLocal.setHours(0, 0, 0, 0)
      } else {
        endLocal = new Date(startLocal)
        endLocal.setDate(endLocal.getDate() + userPeriodLength - 1)
      }

      return startLocal <= today && endLocal >= today
    })

    let cycleInfo = null
    if (activePeriod) {
      const periodStart = new Date(activePeriod.startDate)
      const periodStartLocal = new Date(periodStart.getFullYear(), periodStart.getMonth(), periodStart.getDate())
      periodStartLocal.setHours(0, 0, 0, 0)

      const diff = Math.floor((today.getTime() - periodStartLocal.getTime()) / (1000 * 60 * 60 * 24))
      const daysInPeriod = diff + 1

      cycleInfo = {
        cycleDay: daysInPeriod,
        phase: 'Menstrual',
        phaseDescription: `Day ${daysInPeriod} of period`,
        isOnPeriod: true,
      }
    } else {
      const daysSinceLastPeriodEnd = Math.floor((today.getTime() - lastPeriodEnd.getTime()) / (1000 * 60 * 60 * 24))

      if (daysSinceLastPeriodEnd >= 0) {
        const currentCycleDay = daysSinceLastPeriodEnd + 1 + userPeriodLength

        const ovulationDay = Math.round(avgCycleLength / 2)
        const fertileStart = ovulationDay - 5
        const fertileEnd = ovulationDay

        let phase = 'Follicular'
        if (currentCycleDay >= fertileStart && currentCycleDay <= fertileEnd) {
          phase = 'Ovulation'
        } else if (currentCycleDay > fertileEnd) {
          phase = 'Luteal'
        }

        cycleInfo = {
          cycleDay: currentCycleDay,
          phase,
          phaseDescription: `Day ${currentCycleDay} of ${avgCycleLength}-day cycle (${phase} Phase)`,
          isOnPeriod: false,
        }
      }
    }

    if (!cycleInfo) {
      return res.json({ 
        success: false, 
        message: 'Unable to calculate cycle information',
        reminder: null 
      })
    }

    // Generate reminder using AI
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'AI service is not configured' })
    }

    const genAI = getGeminiClient()
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' })

    const userName = dbUser.name || email.split('@')[0]
    const todaySymptoms = symptoms.map(s => s.type).join(', ') || 'none'
    const todayMoods = moods.map(m => m.type).join(', ') || 'none'

    const context = `
User: ${userName}
Current Phase: ${cycleInfo.phase}
Cycle Day: ${cycleInfo.cycleDay}
Phase Description: ${cycleInfo.phaseDescription}
Today's Symptoms: ${todaySymptoms}
Today's Moods: ${todayMoods}
Average Cycle Length: ${avgCycleLength} days
Average Period Length: ${userPeriodLength} days
`

    const prompt = `You are a supportive and caring period health assistant. Generate a personalized reminder message for a user based on their cycle phase and today's mood/symptoms.

${context}

Generate a short, warm, and supportive reminder message (2-3 sentences max) that includes:
1. A brief acknowledgment of their current cycle phase
2. A motivational or supportive message tailored to their phase
3. A helpful tip or knowledge based on their phase and today's mood/symptoms

The message should be:
- Warm, supportive, and empathetic
- Phase-appropriate (mention their phase if relevant)
- Consider their mood today (if they're feeling down, be extra supportive)
- Include one practical tip or knowledge
- Keep it concise (2-3 sentences)

Generate ONLY the reminder message, no additional text or explanations.`

    const result = await model.generateContent(prompt)
    const response = await result.response
    const reminderText = response.text().trim()

    // Save reminder to database
    const reminder = await prisma.reminder.create({
      data: {
        userId: dbUser.id,
        message: reminderText,
        phase: cycleInfo.phase,
        cycleDay: cycleInfo.cycleDay,
        sentAt: new Date(),
      },
    })

    return res.json({
      success: true,
      test: true,
      user: {
        email: dbUser.email,
        name: dbUser.name,
      },
      cycleInfo,
      todayData: {
        symptoms: symptoms.map(s => ({ type: s.type, severity: s.severity })),
        moods: moods.map(m => m.type),
      },
      reminder: {
        id: reminder.id,
        message: reminderText,
        phase: cycleInfo.phase,
        cycleDay: cycleInfo.cycleDay,
        sentAt: reminder.sentAt,
      },
    })
  } catch (error) {
    console.error('[Reminder Test] Error:', error)
    return res.status(500).json({ 
      error: 'Failed to generate reminder',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    })
  }
})

export default router

