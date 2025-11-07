/**
 * Scheduled job to send AI-generated reminders to users
 * This should run every 3-4 hours
 * 
 * For Vercel/serverless: Use Vercel Cron Jobs or external cron service
 * For local/dedicated server: Use node-cron or similar
 */

import prisma from '../lib/prisma.js'
import { clerk } from '../lib/clerk.js'
import { GoogleGenerativeAI } from '@google/generative-ai'

const MS_PER_DAY = 1000 * 60 * 60 * 24

function toUTCDate(input) {
  if (!input) return null
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return null
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function addDaysUTC(date, days) {
  const result = new Date(date.getTime())
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

// Helper function to calculate cycle info (same as in reminders.js)
function calculateCycleInfo(periods, settings, todayInput) {
  if (!periods || periods.length === 0) {
    return null
  }

  const today = toUTCDate(todayInput || new Date())
  if (!today) {
    return null
  }

  const userPeriodLength = settings?.periodDuration || settings?.averagePeriodLength || 5
  const avgCycleLength = settings?.averageCycleLength || 28

  const sortedPeriods = [...periods].sort(
    (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
  )

  const lastPeriod = sortedPeriods[0]
  const lastPeriodStart = toUTCDate(lastPeriod?.startDate)
  if (!lastPeriodStart) {
    return null
  }

  let lastPeriodEnd = null
  if (lastPeriod?.endDate) {
    lastPeriodEnd = toUTCDate(lastPeriod.endDate)
  } else {
    lastPeriodEnd = addDaysUTC(lastPeriodStart, userPeriodLength - 1)
  }
  if (!lastPeriodEnd) {
    return null
  }

  const activePeriod = sortedPeriods.find(period => {
    const startUTC = toUTCDate(period.startDate)
    if (!startUTC) return false
    const endUTC = period.endDate
      ? toUTCDate(period.endDate)
      : addDaysUTC(startUTC, userPeriodLength - 1)
    if (!endUTC) return false

    return startUTC.getTime() <= today.getTime() && endUTC.getTime() >= today.getTime()
  })

  if (activePeriod) {
    const periodStartUTC = toUTCDate(activePeriod.startDate)
    if (!periodStartUTC) return null

    const diff = Math.floor((today.getTime() - periodStartUTC.getTime()) / MS_PER_DAY)
    const daysInPeriod = diff + 1

    return {
      cycleDay: daysInPeriod,
      phase: 'Menstrual',
      phaseDescription: `Day ${daysInPeriod} of period`,
      isOnPeriod: true,
    }
  }

  const daysSinceLastPeriodEnd = Math.floor((today.getTime() - lastPeriodEnd.getTime()) / MS_PER_DAY)

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
 * Generate AI reminder for a user
 */
async function generateReminderForUser(userId, userData) {
  try {
    const { settings, periods, symptoms, moods, name } = userData

    if (!periods || periods.length === 0) {
      return null
    }

    const todayUTC = toUTCDate(new Date())
    const cycleInfo = calculateCycleInfo(periods, settings, todayUTC)

    if (!cycleInfo) {
      return null
    }

    const userName = name || 'there'
    const todaySymptoms = symptoms.map(s => s.type).join(', ') || 'none'
    const todayMoods = moods.map(m => m.type).join(', ') || 'none'

    const context = `
User: ${userName}
Current Phase: ${cycleInfo.phase}
Cycle Day: ${cycleInfo.cycleDay}
Phase Description: ${cycleInfo.phaseDescription}
Today's Symptoms: ${todaySymptoms}
Today's Moods: ${todayMoods}
Average Cycle Length: ${settings?.averageCycleLength || 28} days
Average Period Length: ${settings?.periodDuration || settings?.averagePeriodLength || 5} days
`

    if (!process.env.GEMINI_API_KEY) {
      console.error('[Reminder Job] GEMINI_API_KEY not configured')
      return null
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
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
        console.log(`[Reminder Job] Successfully generated reminder using model: ${modelName}`)
        break
      } catch (error) {
        lastError = error
        console.log(`[Reminder Job] Model ${modelName} failed: ${error.message}, trying next...`)
        continue
      }
    }
    
    if (!reminderText) {
      throw new Error(`All Gemini models failed. Please verify your API key has access to Generative Language API. Last error: ${lastError?.message || 'Unknown error'}`)
    }

    // Save reminder
    const reminder = await prisma.reminder.create({
      data: {
        userId,
        message: reminderText,
        phase: cycleInfo.phase,
        cycleDay: cycleInfo.cycleDay,
        sentAt: new Date(),
      },
    })

    return {
      reminderId: reminder.id,
      message: reminderText,
      phase: cycleInfo.phase,
      cycleDay: cycleInfo.cycleDay,
    }
  } catch (error) {
    console.error(`[Reminder Job] Error generating reminder for user ${userId}:`, error)
    return null
  }
}

/**
 * Main function to send reminders to all eligible users
 */
export async function sendRemindersToUsers() {
  try {
    console.log('[Reminder Job] Starting reminder job...')

    // Get all users with reminders enabled and period data
    const users = await prisma.user.findMany({
      where: {
        userType: 'SELF', // Only SELF users get reminders
        settings: {
          reminderEnabled: true,
        },
        periods: {
          some: {}, // Has at least one period
        },
      },
      include: {
        settings: true,
        periods: {
          orderBy: { startDate: 'desc' },
          take: 6,
        },
      },
    })

    console.log(`[Reminder Job] Found ${users.length} users eligible for reminders`)

    const results = {
      total: users.length,
      sent: 0,
      failed: 0,
      skipped: 0,
    }

    for (const user of users) {
      try {
        // Check if reminder was sent in last 3 hours
        const lastReminder = await prisma.reminder.findFirst({
          where: { userId: user.id },
          orderBy: { sentAt: 'desc' },
        })

        if (lastReminder) {
          const hoursSinceLastReminder = (Date.now() - new Date(lastReminder.sentAt).getTime()) / (1000 * 60 * 60)
          // Check if reminder was sent in last 3 hours (to allow multiple reminders per day)
          if (hoursSinceLastReminder < 3) {
            console.log(`[Reminder Job] Skipping user ${user.id} - reminder sent ${hoursSinceLastReminder.toFixed(1)} hours ago`)
            results.skipped++
            continue
          }
        }
        
        // Also check if reminder was sent today (for daily cron - prevent duplicates)
        const todayCheck = new Date()
        todayCheck.setHours(0, 0, 0, 0)
        const lastReminderDate = lastReminder ? new Date(lastReminder.sentAt) : null
        if (lastReminderDate) {
          lastReminderDate.setHours(0, 0, 0, 0)
          if (lastReminderDate.getTime() === todayCheck.getTime()) {
            console.log(`[Reminder Job] Skipping user ${user.id} - reminder already sent today`)
            results.skipped++
            continue
          }
        }

        // Get today's symptoms and moods
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const tomorrow = new Date(today)
        tomorrow.setDate(tomorrow.getDate() + 1)

        const [symptoms, moods] = await Promise.all([
          prisma.symptom.findMany({
            where: {
              userId: user.id,
              date: {
                gte: today,
                lt: tomorrow,
              },
            },
          }),
          prisma.mood.findMany({
            where: {
              userId: user.id,
              date: {
                gte: today,
                lt: tomorrow,
              },
            },
          }),
        ])

        const userData = {
          ...user,
          symptoms,
          moods,
          name: user.name,
        }

        const reminder = await generateReminderForUser(user.id, userData)

        if (reminder) {
          console.log(`[Reminder Job] Generated reminder for user ${user.id}: ${reminder.message.substring(0, 50)}...`)
          
          // TODO: Send push notification here
          // For now, we just save the reminder to the database
          // You'll need to integrate with Expo Push Notifications or similar
          
          results.sent++
        } else {
          results.failed++
        }
      } catch (error) {
        console.error(`[Reminder Job] Error processing user ${user.id}:`, error)
        results.failed++
      }
    }

    console.log('[Reminder Job] Job completed:', results)
    return results
  } catch (error) {
    console.error('[Reminder Job] Fatal error:', error)
    throw error
  }
}

// Export for use in cron job or API endpoint
export default sendRemindersToUsers

