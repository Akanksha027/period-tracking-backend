import express from 'express'
import { GoogleGenerativeAI } from '@google/generative-ai'
import prisma from '../lib/prisma.js'
import { clerk } from '../lib/clerk.js'
import jwt from 'jsonwebtoken'
import {
  calculateCycleInfo as calculateCycleInfoWithOffset,
  normalizeOffset,
  inferTimezoneOffsetFromPeriods,
  fromLocalDayNumber,
  getLocalDayNumber,
  MS_PER_DAY,
} from '../utils/cycleInfo.js'

const router = express.Router()

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function formatDisplayDate(input, timezoneOffsetMinutes = 0) {
  let dayNumber = null
  if (typeof input === 'number') {
    dayNumber = input
  } else if (input) {
    dayNumber = getLocalDayNumber(input, timezoneOffsetMinutes)
  }

  if (!Number.isFinite(dayNumber)) {
    return 'unknown'
  }

  const utcDate = fromLocalDayNumber(dayNumber, timezoneOffsetMinutes)
  if (!utcDate || Number.isNaN(utcDate.getTime())) {
    return 'unknown'
  }

  const monthIndex = utcDate.getUTCMonth()
  const day = utcDate.getUTCDate()
  const monthLabel = MONTH_LABELS[monthIndex] ?? 'Mon'
  return `${monthLabel} ${day}`
}

function buildDailyHistory(entries = [], formatEntry, timezoneOffsetMinutes = 0, maxDays = 7) {
  if (!entries || entries.length === 0) {
    return 'None logged recently.'
  }

  const grouped = new Map()
  for (const entry of entries) {
    if (!entry?.date) continue
    const dayNumber = getLocalDayNumber(entry.date, timezoneOffsetMinutes)
    if (!Number.isFinite(dayNumber)) continue
    if (!grouped.has(dayNumber)) {
      grouped.set(dayNumber, [])
    }
    grouped.get(dayNumber).push(entry)
  }

  if (grouped.size === 0) {
    return 'None logged recently.'
  }

  const summaries = Array.from(grouped.entries())
    .sort((a, b) => b[0] - a[0])
    .slice(0, maxDays)
    .map(([dayNumber, list]) => {
      const label = formatDisplayDate(dayNumber, timezoneOffsetMinutes)
      const values = list.map(formatEntry).filter(Boolean)
      return values.length > 0 ? `${label}: ${values.join(', ')}` : `${label}: none`
    })

  return summaries.join('\n')
}

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
 * For OTHER users, returns the viewed user (the SELF user whose data is being viewed)
 */
async function findUserByClerkId(clerkId) {
  try {
    // Check for OTHER users first
    let user = await prisma.user.findFirst({
      where: { 
        clerkId,
        userType: 'OTHER',
      },
      include: {
        viewedUser: true,
      },
    })
    
    // If OTHER user found, return the viewed user (the SELF user)
    if (user && user.userType === 'OTHER' && user.viewedUser) {
      return user.viewedUser
    }
    
    // If no OTHER user, check for SELF user
    if (!user) {
      user = await prisma.user.findFirst({
        where: { clerkId },
      })
    }
    
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
function buildCycleSummary(periods, settings, options = {}) {
  const { today = new Date(), timezoneOffsetMinutes = 0 } = options

  const base = calculateCycleInfoWithOffset(periods, settings, {
    today,
    timezoneOffsetMinutes,
  })

  if (!base) {
    return null
  }

  const periodLengthSetting =
    settings?.periodDuration ?? settings?.averagePeriodLength ?? 5
  const avgPeriodLength = Math.max(1, periodLengthSetting)
  const avgCycleLength =
    base.avgCycleLength ??
    Math.max(1, settings?.averageCycleLength ?? 28)

  const periodStartDayNumber =
    base.periodStartDayNumber ??
    (base.todayDayNumber != null && base.cycleDay != null
      ? base.todayDayNumber - (base.cycleDay - 1)
      : null)

  const periodStartDate =
    periodStartDayNumber != null
      ? fromLocalDayNumber(periodStartDayNumber, timezoneOffsetMinutes)
      : null

  const periodEndDate =
    base.periodEndDayNumber != null
      ? fromLocalDayNumber(base.periodEndDayNumber, timezoneOffsetMinutes)
      : periodStartDayNumber != null
      ? fromLocalDayNumber(
          periodStartDayNumber + avgPeriodLength - 1,
          timezoneOffsetMinutes
        )
      : null

  const nextPeriodDate =
    base.nextPeriodDate ??
    (base.nextPeriodDayNumber != null
      ? fromLocalDayNumber(base.nextPeriodDayNumber, timezoneOffsetMinutes)
      : null)

  const ovulationDayInCycle = Math.max(
    avgPeriodLength + 1,
    Math.round(avgCycleLength / 2)
  )
  const fertileStartInCycle = Math.max(1, ovulationDayInCycle - 5)
  const fertileEndInCycle = Math.max(fertileStartInCycle, ovulationDayInCycle)

  const ovulationDate =
    periodStartDayNumber != null
      ? fromLocalDayNumber(
          periodStartDayNumber + ovulationDayInCycle - 1,
          timezoneOffsetMinutes
        )
      : null

  const fertileWindowStartDate =
    periodStartDayNumber != null
      ? fromLocalDayNumber(
          periodStartDayNumber + fertileStartInCycle - 1,
          timezoneOffsetMinutes
        )
      : null

  const fertileWindowEndDate =
    periodStartDayNumber != null
      ? fromLocalDayNumber(
          periodStartDayNumber + fertileEndInCycle - 1,
          timezoneOffsetMinutes
        )
      : null

  return {
    ...base,
    periodStartDate,
    periodEndDate,
    nextPeriodDate,
    ovulationDate,
    fertileWindowStartDate,
    fertileWindowEndDate,
    timezoneOffsetMinutes,
    avgPeriodLength,
    avgCycleLength,
  }
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
      },
    })

    if (!dbUserWithData) {
      return res.status(404).json({ error: 'User not found' })
    }

    const headerOffsetRaw = req.headers['x-timezone-offset']
    const bodyOffsetRaw = req.body?.timezoneOffsetMinutes
    const headerOffset =
      headerOffsetRaw !== undefined ? normalizeOffset(headerOffsetRaw) : null
    const bodyOffset =
      bodyOffsetRaw !== undefined ? normalizeOffset(bodyOffsetRaw) : null
    const inferredOffset = inferTimezoneOffsetFromPeriods(dbUserWithData.periods)
    const timezoneOffsetMinutes =
      headerOffset !== null
        ? headerOffset
        : bodyOffset !== null
        ? bodyOffset
        : Number.isFinite(inferredOffset)
        ? inferredOffset
        : 0

    const now = new Date()
    const todayDayNumber = getLocalDayNumber(now, timezoneOffsetMinutes)
    const todayStartUtc =
      todayDayNumber != null
        ? fromLocalDayNumber(todayDayNumber, timezoneOffsetMinutes)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const tomorrowStartUtc =
      todayDayNumber != null
        ? fromLocalDayNumber(todayDayNumber + 1, timezoneOffsetMinutes)
        : new Date(todayStartUtc.getTime() + MS_PER_DAY)
    const historyStartUtc =
      todayDayNumber != null
        ? fromLocalDayNumber(todayDayNumber - 13, timezoneOffsetMinutes)
        : new Date(todayStartUtc.getTime() - 13 * MS_PER_DAY)

    // Check if user has period data
    if (!dbUserWithData.periods || dbUserWithData.periods.length === 0) {
      return res.json({ 
        success: false, 
        message: 'No period data available for reminders',
        reminder: null 
      })
    }

    // Calculate cycle info
    const cycleInfo = buildCycleSummary(dbUserWithData.periods, dbUserWithData.settings, {
      today: now,
      timezoneOffsetMinutes,
    })

    if (!cycleInfo) {
      return res.json({ 
        success: false, 
        message: 'Unable to calculate cycle information',
        reminder: null 
      })
    }

    const [recentSymptoms, recentMoods, recentNotes] = await Promise.all([
      prisma.symptom.findMany({
        where: {
          userId: dbUser.id,
          date: {
            gte: historyStartUtc,
            lt: tomorrowStartUtc,
          },
        },
        orderBy: { date: 'desc' },
        take: 200,
      }),
      prisma.mood.findMany({
        where: {
          userId: dbUser.id,
          date: {
            gte: historyStartUtc,
            lt: tomorrowStartUtc,
          },
        },
        orderBy: { date: 'desc' },
        take: 200,
      }),
      prisma.note.findMany({
        where: {
          userId: dbUser.id,
          date: {
            gte: historyStartUtc,
            lt: tomorrowStartUtc,
          },
        },
        orderBy: { date: 'desc' },
        take: 50,
      }),
    ])

    const periodHistory = dbUserWithData.periods
      .map((period) => {
        const startDayNumber = getLocalDayNumber(period.startDate, timezoneOffsetMinutes)
        const start = startDayNumber != null
          ? formatDisplayDate(startDayNumber, timezoneOffsetMinutes)
          : formatDisplayDate(period.startDate, timezoneOffsetMinutes)
        let end = 'ongoing'
        if (period.endDate) {
          const endDayNumber = getLocalDayNumber(period.endDate, timezoneOffsetMinutes)
          end =
            endDayNumber != null
              ? formatDisplayDate(endDayNumber, timezoneOffsetMinutes)
              : formatDisplayDate(period.endDate, timezoneOffsetMinutes)
        } else if (dbUserWithData.settings?.periodDuration && startDayNumber != null) {
          const estimatedEndDayNumber =
            startDayNumber + dbUserWithData.settings.periodDuration - 1
          end = `${formatDisplayDate(estimatedEndDayNumber, timezoneOffsetMinutes)} (estimated)`
        }
        return `${start} – ${end}`
      })
      .join('\n')

    const phaseTimeline = (() => {
      if (todayDayNumber == null) {
        return 'No cycle data available.'
      }
      const daysToShow = 7
      const lines = []
      for (let offset = daysToShow - 1; offset >= 0; offset--) {
        const dayNumber = todayDayNumber - offset
        const dayDate = fromLocalDayNumber(dayNumber, timezoneOffsetMinutes)
        const infoForDay = buildCycleSummary(dbUserWithData.periods, dbUserWithData.settings, {
          today: dayDate,
          timezoneOffsetMinutes,
        })
        if (infoForDay) {
          lines.push(
            `${formatDisplayDate(dayNumber, timezoneOffsetMinutes)}: ${infoForDay.phase} (cycle day ${infoForDay.cycleDay})`
          )
        } else {
          lines.push(`${formatDisplayDate(dayNumber, timezoneOffsetMinutes)}: No cycle data available`)
        }
      }
      return lines.join('\n')
    })()

    const symptomHistory = buildDailyHistory(
      recentSymptoms,
      (entry) =>
        entry.severity
          ? `${entry.type} (severity ${entry.severity})`
          : entry.type,
      timezoneOffsetMinutes
    )

    const moodHistory = buildDailyHistory(
      recentMoods,
      (entry) => entry.type,
      timezoneOffsetMinutes
    )

    const noteHistory = buildDailyHistory(
      recentNotes,
      (entry) => (entry.content ? `"${entry.content.trim()}"` : null),
      timezoneOffsetMinutes
    )

    const userName = dbUserWithData.name || req.user.firstName || 'there'

    const todaysSymptomsEntries =
      todayDayNumber != null
        ? recentSymptoms.filter(
            (entry) =>
              getLocalDayNumber(entry.date, timezoneOffsetMinutes) === todayDayNumber
          )
        : []
    const todaysMoodsEntries =
      todayDayNumber != null
        ? recentMoods.filter(
            (entry) =>
              getLocalDayNumber(entry.date, timezoneOffsetMinutes) === todayDayNumber
          )
        : []

    const todaySymptoms =
      todaysSymptomsEntries.length > 0
        ? todaysSymptomsEntries
            .map((s) =>
              s.severity ? `${s.type} (severity ${s.severity})` : s.type
            )
            .join(', ')
        : 'none'
    const todayMoods =
      todaysMoodsEntries.length > 0
        ? todaysMoodsEntries.map((m) => m.type).join(', ')
        : 'none'

    const contextSections = [
      `USER OVERVIEW:
- Name: ${userName}
- Current Phase: ${cycleInfo.phase}
- Cycle Day: ${cycleInfo.cycleDay}
- Phase Description: ${cycleInfo.phaseDescription}
- Next Period Expected: ${formatDisplayDate(cycleInfo.nextPeriodDate, timezoneOffsetMinutes)}
- Fertility Window: ${formatDisplayDate(cycleInfo.fertileWindowStartDate, timezoneOffsetMinutes)} – ${formatDisplayDate(cycleInfo.fertileWindowEndDate, timezoneOffsetMinutes)}
- Ovulation Day: ${formatDisplayDate(cycleInfo.ovulationDate, timezoneOffsetMinutes)}
- Average Cycle Length: ${cycleInfo.avgCycleLength} days
- Average Period Length: ${cycleInfo.avgPeriodLength} days`,
      `PERIOD HISTORY (most recent):
${periodHistory || 'No period history available.'}`,
      `PHASE TIMELINE (last 7 days):
${phaseTimeline}`,
      `SYMPTOM HISTORY (last 14 days):
${symptomHistory}`,
      `MOOD HISTORY (last 14 days):
${moodHistory}`,
      `NOTES (last 14 days):
${noteHistory}`,
      `TODAY'S LOGS:
- Symptoms: ${todaySymptoms}
- Moods: ${todayMoods}`,
    ]

    const context = contextSections.join('\n\n')

    // Generate reminder using AI
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'AI service is not configured' })
    }

    const genAI = getGeminiClient()
    // Try multiple models in order of preference (same as chat route)
    const modelNames = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-flash-latest', 'gemini-pro-latest']
    
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

    let reminderText = null
    let lastError = null
    
    for (const modelName of modelNames) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName })
        const result = await model.generateContent(prompt)
        const response = await result.response
        reminderText = response.text().trim()
        console.log(`[Reminder] Successfully generated reminder using model: ${modelName}`)
        break
      } catch (error) {
        lastError = error
        console.log(`[Reminder] Model ${modelName} failed: ${error.message}, trying next...`)
        continue
      }
    }
    
    if (!reminderText) {
      throw new Error(`All Gemini models failed. Please verify your API key has access to Generative Language API. Last error: ${lastError?.message || 'Unknown error'}`)
    }

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
        phase: lastReminder.phase,
        cycleDay: lastReminder.cycleDay,
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
    // Try multiple models in order of preference (fastest first)
    const modelNames = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro']
    let model = null
    let lastError = null
    
    for (const modelName of modelNames) {
      try {
        model = genAI.getGenerativeModel({ model: modelName })
        // Test if model works by generating a simple response
        break
      } catch (error) {
        lastError = error
        console.log(`[Reminder] Model ${modelName} failed, trying next...`)
        continue
      }
    }
    
    if (!model) {
      throw new Error(`All Gemini models failed. Please verify your API key. Last error: ${lastError?.message}`)
    }

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

