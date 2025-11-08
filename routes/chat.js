import express from 'express'
import { GoogleGenerativeAI } from '@google/generative-ai'
import prisma from '../lib/prisma.js'
import { clerk } from '../lib/clerk.js'
import jwt from 'jsonwebtoken'
import {
  calculateCycleInfo,
  fromLocalDayNumber,
  getLocalDayNumber,
  inferTimezoneOffsetFromPeriods,
} from '../utils/cycleInfo.js'

const router = express.Router()

const PHASE_EDUCATION = `
MENSTRUAL CYCLE REFERENCE:
• Menstrual Phase: Estrogen and progesterone are lowest; uterine lining sheds. Encourage rest, warmth, iron-rich meals, gentle movement.
• Follicular Phase: FSH matures follicles, estrogen rises, uterine lining rebuilds. Energy and mood often improve—support planning, learning, moderate exercise.
• Ovulation Phase: A sharp LH surge releases the mature egg. Estrogen peaks; fertility is highest. Emphasize hydration, mindful activity, communication about conception intentions.
• Luteal Phase: Corpus luteum produces progesterone to sustain the uterine lining. Watch for PMS, recommend balanced nutrition, magnesium-rich foods, stress management.
Hormone roles:
• FSH matures ovarian follicles and promotes estrogen.
• LH triggers ovulation and supports corpus luteum formation.
• Estrogen regrows the endometrium during the proliferative (follicular) stage.
• Progesterone from the corpus luteum stabilizes the endometrium during the secretory (luteal) stage.
Align all explanations with these evidence-based definitions.`

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

    // Try to get user from token
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
          console.error('[Chat Auth] Error getting user from Clerk:', userError.message)
        }
      }
    } catch (tokenError) {
      console.log('[Chat Auth] Token decode failed:', tokenError.message)
    }

    // Fallback: Try to get user from request body or query params
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
        console.error('[Chat Auth] Error getting user by clerkId:', error)
      }
    }

    if (email) {
      try {
        const users = await clerk.users.getUserList({ limit: 500 })
        const userArray = Array.isArray(users) ? users : (users.data || [])
        for (const user of userArray.slice(0, 100)) {
          try {
            const fullUser = await clerk.users.getUser(user.id)
            if (fullUser.emailAddresses?.some(e => e.emailAddress === email)) {
              req.user = {
                id: fullUser.id,
                email: fullUser.emailAddresses[0]?.emailAddress,
                firstName: fullUser.firstName,
                lastName: fullUser.lastName,
                clerkId: fullUser.id,
              }
              return next()
            }
          } catch (err) {
            continue
          }
        }
      } catch (error) {
        console.error('[Chat Auth] Error searching users:', error)
      }
    }

    return res.status(401).json({ error: 'Unauthorized' })
  } catch (error) {
    console.error('[Chat Auth] Error:', error)
    return res.status(401).json({ error: 'Unauthorized' })
  }
}

/**
 * Helper function to find user by Clerk ID
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
    console.error('[Chat] Error finding user:', error)
    return null
  }
}

function resolveTimezoneOffset(req, periods) {
  const header = req.headers?.['x-timezone-offset']
  const headerValue = Array.isArray(header) ? header[0] : header
  if (headerValue !== undefined) {
    const parsed = parseInt(headerValue, 10)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return inferTimezoneOffsetFromPeriods(periods)
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
 * POST /api/chat - Chat with AI
 */
router.post('/', verifyClerkAuth, async (req, res) => {
  try {
    const { messages, symptoms } = req.body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' })
    }

    // Find viewer record (could be SELF or OTHER)
    const viewerRecord = await prisma.user.findFirst({
      where: { clerkId: req.user.clerkId },
      include: { viewedUser: true },
    })

    // Find user in database (SELF target when viewer)
    const dbUser = await findUserByClerkId(req.user.clerkId)
    
    if (!dbUser) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Fetch user with all related data
    const dbUserWithData = await prisma.user.findUnique({
      where: { id: dbUser.id },
      include: {
        settings: true,
        periods: {
          orderBy: { startDate: 'desc' },
          take: 12, // Only last 12 periods
        },
        symptoms: {
          orderBy: { date: 'desc' },
          take: 100, // Increased to get more symptom history for pattern recognition
        },
        moods: {
          orderBy: { date: 'desc' },
          take: 100, // Increased to get more mood history for pattern recognition
        },
        notes: {
          orderBy: { date: 'desc' },
          take: 50, // Increased to get more personal notes and concerns
        },
      },
    })

    if (!dbUserWithData) {
      return res.status(404).json({ error: 'User not found' })
    }

    const trackedUserName = dbUserWithData.name || viewerRecord?.viewedUser?.name || req.user.firstName || 'there'
    const viewerName =
      req.user.firstName ||
      viewerRecord?.name ||
      req.user.email?.split('@')[0] ||
      'there'
    const isViewerMode = viewerRecord?.userType === 'OTHER' && viewerRecord?.viewedUser
    const conversationName = isViewerMode ? viewerName : trackedUserName

    // Check if Gemini API key is configured
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set in environment variables')
      return res.status(500).json({ error: 'AI service is not configured. Please contact support.' })
    }

    const participantInstruction = isViewerMode
      ? `You are speaking with ${viewerName}, who is caring for ${trackedUserName}. Address ${viewerName} directly, refer to ${trackedUserName} in third-person, and focus on what ${viewerName} can do to help her. If data is missing, guide ${viewerName} on how to track observations rather than simply saying data is unavailable.`
      : `You are speaking directly with ${trackedUserName}. Address her needs personally and provide guidance tailored to her experiences.`

    const systemPrompt = `
You are Peri Peri Health Assistant, a professional and knowledgeable women's health assistant. Always identify yourself as "Peri Peri Health Assistant" in responses.

${participantInstruction}

**YOUR CORE MISSION:**
You have COMPLETE ACCESS to ${trackedUserName}'s period tracking data, symptom history, mood patterns, personal notes, cycle patterns, and settings. Use ALL of this data to provide HIGHLY PERSONALIZED advice that is specific to her patterns, not generic information. Demonstrate awareness of her history and identify patterns in her cycle and symptoms.

**CRITICAL CYCLE AWARENESS:**
- You will be provided with the user's CURRENT CYCLE DAY and PHASE (Menstrual, Follicular, Ovulation, or Luteal)
- You will know exactly which day of their cycle they are on (e.g., "Day 15 of 28-day cycle")
- You will know when their last period was and when their next period is predicted
- ALWAYS reference their current cycle phase and day when giving advice about symptoms, moods, or cycle-related questions
- If ${trackedUserName} has NOT logged any periods, you MUST tell ${conversationName} that period logging is needed for precise insights
- Use the cycle information to provide phase-specific advice and predictions

**COMMUNICATION STYLE:**
- Professional, clear, and informative tone
- Address the conversational partner by name ("${conversationName}")
- Provide comprehensive medical information and explanations in plain language
- Be empathetic while maintaining professionalism
- Focus on education and understanding
- Provide actionable, evidence-based advice
- Distinguish between normal symptoms and when medical attention is needed
- ALWAYS reference specific data from ${trackedUserName}'s tracking history—dates, frequencies, patterns
- IDENTIFY PATTERNS in symptoms, moods, and cycle phases
- CORRELATE symptoms with moods and cycle phases when patterns exist
- PREDICT based on ${trackedUserName}'s actual cycle history, not generic averages

**RESPONSE STRUCTURE FOR SYMPTOM QUERIES:**
1. START with EMOTIONAL SUPPORT and VALIDATION
   - Acknowledge feelings and validate the experience
   - Use supportive, caring language
   - Let them know they're not alone and it's okay to feel this way

2. Provide PRACTICAL TIPS and ACTIONABLE SUGGESTIONS (majority of response)
   - Focus ONLY on what can be done RIGHT NOW to feel better
   - Offer specific, easy-to-implement remedies
   - Include dietary recommendations with specific foods
   - Mention lifestyle changes, exercises, and self-care practices
   - Give step-by-step guidance for relief
   - Avoid scientific mechanisms; stay practical

3. PERSONALIZE using ${trackedUserName}'s data
   - Reference patterns in the tracked data
   - Suggest when issues might arise based on the cycle
   - Tailor tips to ${trackedUserName}'s specific situation

4. PRODUCT SUGGESTIONS (when relevant)
   - List helpful products/tools with direct links (Swiggy, Zomato, BigBasket, etc.)

**CRITICAL RULES:**
1. ALWAYS address the conversational partner by name ("${conversationName}"). When in viewer mode, explicitly mention how ${conversationName} can support ${trackedUserName}.
2. No emojis or overly casual symbols.
3. Begin with emotional validation.
4. Focus on practical, immediate guidance; avoid deep scientific explanations.
5. Pair emotional support with physical tips.
6. Utilize the COMPLETE tracking history—cycle data, symptoms, moods, notes.
7. Identify and reference patterns before offering generic advice.
8. Cite specific dates, frequencies, and trends from the data.
9. Predict upcoming needs based on historical patterns.
10. Keep responses comprehensive and never cut off mid-sentence.

Follow these instructions exactly in every response.`

    // Build comprehensive user context from ALL their data
    let userCycleContext = ''
    if (isViewerMode) {
      userCycleContext += `\nThe person chatting is ${viewerName}, who is supporting ${trackedUserName}. All recommendations should be framed as guidance for ${viewerName} to help ${trackedUserName}.\n`
    }
    
    if (!dbUserWithData) {
      userCycleContext += `\n\nIMPORTANT: User data not found. Provide general guidance only.`
    } else {
      const hasPeriodData = dbUserWithData.periods && dbUserWithData.periods.length > 0
      const hasSymptomData = dbUserWithData.symptoms && dbUserWithData.symptoms.length > 0
      const hasMoodData = dbUserWithData.moods && dbUserWithData.moods.length > 0
      const hasNoteData = dbUserWithData.notes && dbUserWithData.notes.length > 0
      const hasSettings = dbUserWithData.settings !== null

      const inferredOffsetRaw = resolveTimezoneOffset(req, dbUserWithData.periods)
      const inferredOffset = Number.isFinite(inferredOffsetRaw) ? inferredOffsetRaw : 0

      if (hasPeriodData || hasSymptomData || hasMoodData || hasNoteData || hasSettings) {
        userCycleContext += `\n\nCOMPLETE USER PROFILE INFORMATION - Use ALL of this data to provide personalized, comprehensive advice:\n\n`
        
        // User Basic Info
        userCycleContext += `USER PROFILE (${trackedUserName} - supported by ${viewerName}):\n`
        userCycleContext += `- Email: ${dbUserWithData.email || 'not provided'}\n`
        
        // Get user's average period length from settings (default 5 days) - use this for all calculations
        const userPeriodLength = dbUserWithData.settings?.periodDuration || 
                                 dbUserWithData.settings?.averagePeriodLength || 
                                 5
        userCycleContext += PHASE_EDUCATION
        
        // Period Data
        if (hasPeriodData && dbUserWithData.periods) {
          // Use the user's period length setting
          const avgPeriodLength = userPeriodLength
          
          userCycleContext += `\nPERIOD HISTORY (${dbUserWithData.periods.length} periods tracked):\n`
          const recentPeriods = dbUserWithData.periods.slice(0, 10)
          recentPeriods.forEach((p, idx) => {
            const start = new Date(p.startDate)
            const startDateStr = start.toLocaleDateString()
            
            // Calculate end date if not set
            let endDateStr = 'ongoing'
            if (p.endDate) {
              endDateStr = new Date(p.endDate).toLocaleDateString()
            } else {
              // Calculate end date based on average period length
              const calculatedEnd = new Date(start)
              calculatedEnd.setDate(calculatedEnd.getDate() + avgPeriodLength - 1)
              endDateStr = calculatedEnd.toLocaleDateString()
            }
            
            userCycleContext += `  ${idx + 1}. ${startDateStr} to ${endDateStr}${p.flowLevel ? ` - ${p.flowLevel} flow` : ''}\n`
          })
          if (dbUserWithData.periods.length > 10) {
            userCycleContext += `  ... and ${dbUserWithData.periods.length - 10} more periods\n`
          }
          
          // Calculate cycle statistics
          if (dbUserWithData.periods.length >= 2) {
            const cycles = []
            const periodLengths = []
            for (let i = 0; i < dbUserWithData.periods.length - 1; i++) {
              const current = new Date(dbUserWithData.periods[i].startDate)
              const next = new Date(dbUserWithData.periods[i + 1].startDate)
              const diff = Math.ceil((current.getTime() - next.getTime()) / (1000 * 60 * 60 * 24))
              cycles.push(Math.abs(diff))
              
              const endDate = dbUserWithData.periods[i].endDate
              if (endDate) {
                const periodStart = new Date(dbUserWithData.periods[i].startDate)
                const periodEnd = new Date(endDate)
                const periodDays = Math.ceil((periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24)) + 1
                periodLengths.push(periodDays)
              }
            }
            
            const avgCycle = cycles.length > 0 ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null
            const calculatedAvgPeriodLength = periodLengths.length > 0 ? Math.round(periodLengths.reduce((a, b) => a + b, 0) / periodLengths.length) : null
            
            // Use settings period duration, or calculated, or default to 5
            const finalAvgPeriodLength = dbUserWithData.settings?.periodDuration || 
                                         dbUserWithData.settings?.averagePeriodLength || 
                                         calculatedAvgPeriodLength || 
                                         5
            
            if (avgCycle) userCycleContext += `- Average Cycle Length: ${avgCycle} days\n`
            userCycleContext += `- Average Period Duration: ${finalAvgPeriodLength} days (from user settings${calculatedAvgPeriodLength ? ' and history' : ''})\n`
            
            // Next period prediction
            if (avgCycle) {
              const lastPeriod = new Date(dbUserWithData.periods[0].startDate)
              const nextPredicted = new Date(lastPeriod)
              nextPredicted.setDate(nextPredicted.getDate() + avgCycle)
              userCycleContext += `- Next Period Predicted: Around ${nextPredicted.toLocaleDateString()}\n`
            }
          }
          
          const cycleInfo = calculateCycleInfo(dbUserWithData.periods, dbUserWithData.settings, {
            today: new Date(),
            timezoneOffsetMinutes: inferredOffset,
          })

          let currentCycleDay = null
          let currentPhase = null
          let cycleDayDescription = ''
          let daysUntilNextPeriod = null
          let nextPeriodPredicted = null

          if (cycleInfo) {
            currentCycleDay = cycleInfo.cycleDay
            currentPhase = cycleInfo.phase
            cycleDayDescription = cycleInfo.phaseDescription
            nextPeriodPredicted = cycleInfo.nextPeriodDate
            if (cycleInfo.nextPeriodDayNumber !== null && cycleInfo.todayDayNumber !== null) {
              daysUntilNextPeriod = cycleInfo.nextPeriodDayNumber - cycleInfo.todayDayNumber
            }
          }

          const avgCycleLength = cycleInfo?.avgCycleLength || dbUserWithData.settings?.averageCycleLength || 28
          const periodStartLocal = cycleInfo?.periodStartDayNumber != null
            ? fromLocalDayNumber(cycleInfo.periodStartDayNumber, inferredOffset)
            : null
          const periodEndLocal = cycleInfo?.periodEndDayNumber != null
            ? fromLocalDayNumber(cycleInfo.periodEndDayNumber, inferredOffset)
            : null

          if (cycleInfo?.isOnPeriod) {
            const totalPeriodDays = cycleInfo.periodEndDayNumber - cycleInfo.periodStartDayNumber + 1
            userCycleContext += `\n- CURRENT CYCLE STATUS:\n`
            userCycleContext += `  • Phase: Menstrual (Period)\n`
            userCycleContext += `  • Cycle Day: ${cycleInfo.cycleDay} (Day ${cycleInfo.cycleDay} of period)\n`
            if (periodStartLocal) {
              userCycleContext += `  • Period Started: ${periodStartLocal.toLocaleDateString()}\n`
            }
            if (periodEndLocal) {
              userCycleContext += `  • Period Ends: ${periodEndLocal.toLocaleDateString()}\n`
            }
            userCycleContext += `  • Total Period Days: ${totalPeriodDays}\n`
          } else if (cycleInfo) {
            userCycleContext += `\n- CURRENT CYCLE STATUS:\n`
            userCycleContext += `  • Phase: ${cycleInfo.phase}\n`
            userCycleContext += `  • Cycle Day: ${cycleInfo.cycleDay} of ${cycleInfo.avgCycleLength}\n`
            if (periodStartLocal && periodEndLocal) {
              userCycleContext += `  • Last Period: ${periodStartLocal.toLocaleDateString()} to ${periodEndLocal.toLocaleDateString()}\n`
              const daysSinceEnd = cycleInfo.todayDayNumber - cycleInfo.periodEndDayNumber
              userCycleContext += `  • Days Since Period Ended: ${daysSinceEnd}\n`
            }
          } else {
            userCycleContext += `\n- CURRENT CYCLE STATUS:\n  • Unable to calculate cycle data (missing recent period logs)\n`
          }

          if (nextPeriodPredicted) {
            const daysUntil = daysUntilNextPeriod != null ? Math.max(daysUntilNextPeriod, 0) : null
            userCycleContext += `  • Next Period Predicted: ${nextPeriodPredicted.toLocaleDateString()}`
            if (daysUntil !== null) {
              userCycleContext += ` (${daysUntil} days away)`
            }
            userCycleContext += `\n`
          }

          userCycleContext += `\n- IMPORTANT CYCLE INFORMATION:\n`
          userCycleContext += `  • Current Status: ${cycleDayDescription || 'Unable to calculate'}\n`
          userCycleContext += `  • Average Cycle Length: ${avgCycleLength} days\n`
          userCycleContext += `  • Average Period Length: ${userPeriodLength} days\n`
          userCycleContext += `  • When user asks about their cycle, phase, or cycle day, ALWAYS mention: "${cycleDayDescription || 'Please log your periods to track your cycle'}"\n`
          userCycleContext += `  • Reference the current phase (${currentPhase || 'Unknown'}) when giving advice about symptoms, moods, or cycle-related questions\n`
        } else {
          // No period data - important message for AI
          userCycleContext += `\n\n⚠️ IMPORTANT: The user has NOT logged any period information yet.\n`
          userCycleContext += `- When they ask about their cycle, phase, cycle day, or period predictions, you MUST tell them:\n`
          userCycleContext += `  "I notice you haven't updated any period information in the app yet. To give you personalized insights about your cycle, track when your periods occur, and help you understand which phase you're in, please log your periods in the app first. However, I'm still here to help you with any questions you have!"\n`
          userCycleContext += `- Do NOT make up cycle information or assume default values\n`
          userCycleContext += `- Still answer their other questions about symptoms, health, etc., but be clear about cycle information limitations\n`
        }
        
        if (hasSymptomData && dbUserWithData.symptoms) {
          userCycleContext += `\nSYMPTOM TRACKING (${dbUserWithData.symptoms.length} entries - COMPLETE HISTORY):\n`
          const symptomsWithLocalDate = dbUserWithData.symptoms
            .map((s) => {
              const initialDay = getLocalDayNumber(s.date, inferredOffset)
              const initialLocalDate = fromLocalDayNumber(initialDay, inferredOffset)
              const effectiveDateCandidate = initialLocalDate instanceof Date && !Number.isNaN(initialLocalDate.getTime())
                ? initialLocalDate
                : new Date(s.date)

              if (!(effectiveDateCandidate instanceof Date) || Number.isNaN(effectiveDateCandidate.getTime())) {
                return null
              }

              const effectiveDayNumber = initialDay ?? getLocalDayNumber(effectiveDateCandidate, inferredOffset)

              if (effectiveDayNumber === null) {
                return null
              }

              return {
                raw: s,
                localDay: effectiveDayNumber,
                localDate: effectiveDateCandidate,
              }
            })
            .filter(Boolean)
          
          const symptomCounts = {}
          const symptomCycleCorrelation = {}
          
          symptomsWithLocalDate.forEach(({ raw: s, localDay, localDate }) => {
            if (!symptomCounts[s.type]) {
              symptomCounts[s.type] = { count: 0, avgSeverity: 0, recent: [], dates: [], severities: [] }
            }
            symptomCounts[s.type].count++
            symptomCounts[s.type].avgSeverity += s.severity
            symptomCounts[s.type].recent.push(localDate)
            symptomCounts[s.type].dates.push(localDate)
            symptomCounts[s.type].severities.push(s.severity)
            
            // Correlate symptom with cycle phase
            if (dbUserWithData.periods.length > 0) {
              const symptomDay = localDay
              const sortedPeriods = [...dbUserWithData.periods].sort((a, b) => new Date(b.startDate) - new Date(a.startDate))
              
              // Find which period this symptom is closest to
              for (const period of sortedPeriods) {
                const periodStartDay = getLocalDayNumber(period.startDate, inferredOffset)
                if (periodStartDay == null) continue
                const periodEndDay =
                  getLocalDayNumber(period.endDate, inferredOffset) ??
                  periodStartDay + userPeriodLength - 1
                
                const daysSincePeriodStart = symptomDay - periodStartDay
                
                if (daysSincePeriodStart >= -7 && daysSincePeriodStart <= userPeriodLength + 14) {
                  let phase = 'unknown'
                  if (daysSincePeriodStart < 0) phase = 'PMS/Pre-period'
                  else if (daysSincePeriodStart >= 0 && daysSincePeriodStart < userPeriodLength) phase = 'Period'
                  else if (daysSincePeriodStart >= userPeriodLength && daysSincePeriodStart < userPeriodLength + 7) phase = 'Post-period'
                  else if (daysSincePeriodStart >= userPeriodLength + 7 && daysSincePeriodStart < userPeriodLength + 14) phase = 'Fertile/Ovulation'
                  else phase = 'Luteal'
                  
                  if (!symptomCycleCorrelation[s.type]) {
                    symptomCycleCorrelation[s.type] = {}
                  }
                  if (!symptomCycleCorrelation[s.type][phase]) {
                    symptomCycleCorrelation[s.type][phase] = 0
                  }
                  symptomCycleCorrelation[s.type][phase]++
                  break
                }
              }
            }
          })
          
          const symptomAnalysis = Object.entries(symptomCounts)
            .map(([type, data]) => ({
              type,
              count: data.count,
              avgSeverity: Math.round((data.avgSeverity / data.count) * 10) / 10,
              maxSeverity: Math.max(...data.severities),
              minSeverity: Math.min(...data.severities),
              lastOccurrence: new Date(Math.max(...data.recent.map(d => d.getTime()))),
              firstOccurrence: new Date(Math.min(...data.recent.map(d => d.getTime()))),
              cycleCorrelation: symptomCycleCorrelation[type] || {},
              trend: data.severities.length >= 3 ? 
                (data.severities.slice(-3).reduce((a, b) => a + b, 0) / 3 > data.avgSeverity ? 'increasing' : 
                 data.severities.slice(-3).reduce((a, b) => a + b, 0) / 3 < data.avgSeverity ? 'decreasing' : 'stable') 
                : 'unknown'
            }))
            .sort((a, b) => b.count - a.count)
          
          userCycleContext += `- Complete Symptom Analysis:\n`
          symptomAnalysis.forEach(s => {
            userCycleContext += `  • ${s.type}:\n`
            userCycleContext += `    - Frequency: ${s.count} times logged\n`
            userCycleContext += `    - Severity: Average ${s.avgSeverity}/5, Range ${s.minSeverity}-${s.maxSeverity}/5\n`
            userCycleContext += `    - Trend: ${s.trend}\n`
            userCycleContext += `    - First logged: ${s.firstOccurrence.toLocaleDateString()}\n`
            userCycleContext += `    - Last logged: ${s.lastOccurrence.toLocaleDateString()}\n`
            if (Object.keys(s.cycleCorrelation).length > 0) {
              const topPhase = Object.entries(s.cycleCorrelation).sort(([, a], [, b]) => b - a)[0]
              userCycleContext += `    - Most common during: ${topPhase[0]} phase (${topPhase[1]} times)\n`
            }
          })
          
          // Recent symptoms (last 7 days)
          const sevenDaysAgo = new Date()
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
          const recentSymptoms = symptomsWithLocalDate
            .filter((s) => s.localDate >= sevenDaysAgo)
            .sort((a, b) => b.localDate.getTime() - a.localDate.getTime())
          
          if (recentSymptoms.length > 0) {
            userCycleContext += `\n- Recent Symptoms (Last 7 Days):\n`
            recentSymptoms.forEach(({ raw: s, localDate }) => {
              userCycleContext += `  • ${localDate.toLocaleDateString()}: ${s.type} (severity: ${s.severity}/5)\n`
            })
          }
        }
        
        // Mood Data - Enhanced with cycle correlation
        if (hasMoodData && dbUserWithData.moods) {
          userCycleContext += `\nMOOD TRACKING (${dbUserWithData.moods.length} entries - COMPLETE HISTORY):\n`
          
          const moodCounts = {}
          const moodCycleCorrelation = {}
          const moodWithLocalDate = dbUserWithData.moods
            .map((m) => {
              const initialDay = getLocalDayNumber(m.date, inferredOffset)
              const initialLocalDate = fromLocalDayNumber(initialDay, inferredOffset)
              const effectiveDateCandidate = initialLocalDate instanceof Date && !Number.isNaN(initialLocalDate.getTime())
                ? initialLocalDate
                : new Date(m.date)

              if (!(effectiveDateCandidate instanceof Date) || Number.isNaN(effectiveDateCandidate.getTime())) {
                return null
              }

              const effectiveDayNumber = initialDay ?? getLocalDayNumber(effectiveDateCandidate, inferredOffset)

              if (effectiveDayNumber === null) {
                return null
              }

              return {
                raw: m,
                localDay: effectiveDayNumber,
                localDate: effectiveDateCandidate,
              }
            })
            .filter(Boolean)
          
          moodWithLocalDate.forEach(({ raw: m, localDay, localDate }) => {
            moodCounts[m.type] = (moodCounts[m.type] || 0) + 1
            
            if (dbUserWithData.periods.length > 0) {
              const sortedPeriods = [...dbUserWithData.periods].sort((a, b) => new Date(b.startDate) - new Date(a.startDate))
              
              for (const period of sortedPeriods) {
                const periodStartDay = getLocalDayNumber(period.startDate, inferredOffset)
                if (periodStartDay == null) continue
                const periodEndDay =
                  getLocalDayNumber(period.endDate, inferredOffset) ??
                  periodStartDay + userPeriodLength - 1
                
                const daysSincePeriodStart = localDay - periodStartDay
                
                if (daysSincePeriodStart >= -7 && daysSincePeriodStart <= userPeriodLength + 14) {
                  let phase = 'unknown'
                  if (daysSincePeriodStart < 0) phase = 'PMS/Pre-period'
                  else if (daysSincePeriodStart < userPeriodLength) phase = 'Period'
                  else if (daysSincePeriodStart < userPeriodLength + 7) phase = 'Post-period'
                  else if (daysSincePeriodStart < userPeriodLength + 14) phase = 'Fertile/Ovulation'
                  else phase = 'Luteal'
                  
                  if (!moodCycleCorrelation[m.type]) {
                    moodCycleCorrelation[m.type] = {}
                  }
                  if (!moodCycleCorrelation[m.type][phase]) {
                    moodCycleCorrelation[m.type][phase] = 0
                  }
                  moodCycleCorrelation[m.type][phase]++
                  break
                }
              }
            }
          })
          
          const mostCommonMoods = Object.entries(moodCounts)
            .sort(([, a], [, b]) => b - a)
            .map(([mood, count]) => ({ mood, count, correlation: moodCycleCorrelation[mood] || {} }))
          
          userCycleContext += `- Complete Mood Analysis:\n`
          mostCommonMoods.slice(0, 10).forEach(({ mood, count, correlation }) => {
            userCycleContext += `  • ${mood}: ${count} times logged`
            if (Object.keys(correlation).length > 0) {
              const topPhase = Object.entries(correlation).sort(([, a], [, b]) => b - a)[0]
              userCycleContext += ` (most common during ${topPhase[0]} phase: ${topPhase[1]} times)`
            }
            userCycleContext += `\n`
          })
          
          const moodSevenDaysAgo = new Date()
          moodSevenDaysAgo.setDate(moodSevenDaysAgo.getDate() - 7)
          const recentMoods = moodWithLocalDate
            .filter((m) => m.localDate >= moodSevenDaysAgo)
            .sort((a, b) => b.localDate.getTime() - a.localDate.getTime())
          
          if (recentMoods.length > 0) {
            userCycleContext += `\n- Recent Moods (Last 7 Days):\n`
            recentMoods.forEach(({ raw: m, localDate }) => {
              userCycleContext += `  • ${localDate.toLocaleDateString()}: ${m.type}\n`
            })
          }
          
          const positiveMoods = ['happy', 'energetic', 'calm', 'excited', 'confident', 'grateful', 'peaceful']
          const negativeMoods = ['anxious', 'sad', 'irritated', 'stressed', 'tired', 'overwhelmed', 'frustrated']
          
          const positiveCount = mostCommonMoods
            .filter((m) => positiveMoods.includes(m.mood))
            .reduce((sum, m) => sum + m.count, 0)
          const negativeCount = mostCommonMoods
            .filter((m) => negativeMoods.includes(m.mood))
            .reduce((sum, m) => sum + m.count, 0)
          
          if (positiveCount + negativeCount > 0) {
            const positiveRatio = ((positiveCount / (positiveCount + negativeCount)) * 100).toFixed(1)
            userCycleContext += `\n- Emotional Pattern: ${positiveRatio}% positive moods, ${(100 - positiveRatio).toFixed(1)}% challenging moods\n`
          }
        }
        
        // Settings - Complete user profile (ALWAYS USE THESE CURRENT SETTINGS)
        if (hasSettings && dbUserWithData.settings) {
          userCycleContext += `\nUSER PROFILE & SETTINGS (CURRENT - USE THESE VALUES FOR ALL CALCULATIONS):\n`
          if (dbUserWithData.settings.birthYear) {
            const currentYear = new Date().getFullYear()
            const age = currentYear - dbUserWithData.settings.birthYear
            userCycleContext += `- Age: ${age} years old (born ${dbUserWithData.settings.birthYear})\n`
          }
          const cycleLength = dbUserWithData.settings.averageCycleLength || 28
          const periodLength = dbUserWithData.settings.averagePeriodLength || dbUserWithData.settings.periodDuration || 5
          userCycleContext += `- Average Cycle Length: ${cycleLength} days (USE THIS for cycle predictions)\n`
          userCycleContext += `- Average Period Length: ${periodLength} days (USE THIS for period end date calculations)\n`
          if (dbUserWithData.settings.lastPeriodDate) {
            userCycleContext += `- Last Period Date (from settings): ${new Date(dbUserWithData.settings.lastPeriodDate).toLocaleDateString()}\n`
          }
          userCycleContext += `- Reminders: ${dbUserWithData.settings.reminderEnabled ? 'Enabled' : 'Disabled'}\n`
          if (dbUserWithData.settings.reminderEnabled) {
            userCycleContext += `- Reminder Days Before: ${dbUserWithData.settings.reminderDaysBefore || 3} days\n`
          }
          userCycleContext += `- IMPORTANT: These settings are the user's CURRENT preferences. Always use these values (${cycleLength} day cycle, ${periodLength} day period) when calculating predictions, phase information, and period end dates. These settings override any historical averages.\n`
        }
        
        // Cycle Irregularity Detection
        if (hasPeriodData && dbUserWithData.periods.length >= 3) {
          const cycles = []
          for (let i = 0; i < dbUserWithData.periods.length - 1; i++) {
            const current = new Date(dbUserWithData.periods[i].startDate)
            const next = new Date(dbUserWithData.periods[i + 1].startDate)
            const diff = Math.abs(Math.ceil((current.getTime() - next.getTime()) / (1000 * 60 * 60 * 24)))
            cycles.push(diff)
          }
          
          if (cycles.length > 0) {
            const avgCycle = cycles.reduce((a, b) => a + b, 0) / cycles.length
            const minCycle = Math.min(...cycles)
            const maxCycle = Math.max(...cycles)
            const cycleVariation = maxCycle - minCycle
            
            userCycleContext += `\n- Cycle Regularity Analysis:\n`
            userCycleContext += `  • Average cycle: ${Math.round(avgCycle)} days\n`
            userCycleContext += `  • Cycle range: ${minCycle} to ${maxCycle} days (variation: ${cycleVariation} days)\n`
            if (cycleVariation > 7) {
              userCycleContext += `  • NOTE: Cycles are irregular (variation > 7 days). This is common and may affect predictions.\n`
            }
          }
        }
        
        // Notes - Personal Concerns and Experiences
        if (hasNoteData && dbUserWithData.notes) {
          userCycleContext += `\nPERSONAL NOTES & CONCERNS (${dbUserWithData.notes.length} entries - COMPLETE HISTORY):\n`
          userCycleContext += `These notes contain personal concerns, experiences, and observations the user has shared:\n`
          
          dbUserWithData.notes.forEach((n, idx) => {
            const noteDate = new Date(n.date).toLocaleDateString()
            userCycleContext += `  ${idx + 1}. [${noteDate}] ${n.content}\n`
          })
          
          userCycleContext += `- IMPORTANT: Reference these notes to understand what matters to her, what concerns she has, and what she's experiencing. Use this context to provide empathetic, personalized responses.\n`
        }
        
        // Symptom-Mood Correlation
        const toLocalDateString = (dateValue) => {
          const dayNumber = getLocalDayNumber(dateValue, inferredOffset)
          const localDate = fromLocalDayNumber(dayNumber, inferredOffset)
          if (localDate && !Number.isNaN(localDate.getTime())) {
            return localDate.toDateString()
          }
          return new Date(dateValue).toDateString()
        }

        if (hasSymptomData && hasMoodData && dbUserWithData.symptoms.length > 0 && dbUserWithData.moods.length > 0) {
          userCycleContext += `\nSYMPTOM-MOOD CORRELATION ANALYSIS:\n`
          
          // Find days where both symptoms and moods were logged
          const symptomDates = new Set(dbUserWithData.symptoms.map((s) => toLocalDateString(s.date)))
          const moodDates = new Set(dbUserWithData.moods.map((m) => toLocalDateString(m.date)))
          const commonDates = [...symptomDates].filter(d => moodDates.has(d))
          
          if (commonDates.length > 0) {
            userCycleContext += `- Days with both symptoms and moods logged: ${commonDates.length}\n`
            
            // Analyze correlations on same days
            commonDates.slice(0, 10).forEach(dateStr => {
              const date = new Date(dateStr)
              const daySymptoms = dbUserWithData.symptoms.filter(s => toLocalDateString(s.date) === dateStr)
              const dayMoods = dbUserWithData.moods.filter(m => toLocalDateString(m.date) === dateStr)
              
              if (daySymptoms.length > 0 && dayMoods.length > 0) {
                const avgSeverity = daySymptoms.reduce((sum, s) => sum + s.severity, 0) / daySymptoms.length
                const symptomTypes = daySymptoms.map(s => `${s.type} (${s.severity}/5)`).join(', ')
                const moodTypes = dayMoods.map(m => m.type).join(', ')
                userCycleContext += `  • ${date.toLocaleDateString()}: ${symptomTypes} → Moods: ${moodTypes}\n`
              }
            })
          }
        }
        
        userCycleContext += `\n\nCRITICAL INSTRUCTIONS FOR USING THIS DATA - YOU MUST FOLLOW THESE:\n
1. **ALWAYS USE ACTUAL USER DATA**: Reference specific dates, patterns, and frequencies from the data above. Don't make generic statements.\n
2. **IDENTIFY SYMPTOM PATTERNS**: If symptoms correlate with cycle phases (e.g., "cramps during PMS phase"), mention this pattern clearly.\n
3. **PERSONALIZE PREDICTIONS**: Use her actual cycle history to predict when symptoms might occur next. Say things like "Based on your pattern, you typically experience [symptom] around [specific cycle day]."\n
4. **CORRELATE SYMPTOMS & MOODS**: If she logged both symptoms and moods on the same days, acknowledge this connection. For example: "I notice when you experience [symptom], you also tend to feel [mood]."\n
5. **ACKNOWLEDGE TRENDS**: If symptom severity is increasing/decreasing, mention this trend and ask if something has changed.\n
6. **CYCLE-AWARE ADVICE**: Tailor advice based on where she is in her cycle. If she's in PMS phase and has a history of certain symptoms, mention this.\n
7. **AGE-APPROPRIATE GUIDANCE**: If age is available, adjust advice accordingly (e.g., different concerns for teens vs adults).\n
8. **PREVENTIVE SUGGESTIONS**: Based on patterns, suggest proactive measures. For example: "Since you typically get [symptom] during [phase], you might want to [specific action] 2-3 days before."\n
9. **VALIDATE EXPERIENCES**: Acknowledge her specific symptoms and frequencies. Say "I see you've logged [symptom] [X] times, and it's been [trend]."\n
10. **USE ALL DATA POINTS**: Reference periods, symptoms, moods, and notes together to give comprehensive advice. Don't ignore any data category.\n
11. **BE SPECIFIC**: Instead of "your cycle," say "your [X]-day cycle" or "your period that started on [date]."\n
12. **IDENTIFY PATTERNS FIRST**: When user asks about symptoms, first check if they've logged similar symptoms before and in which cycle phase.\n
13. **PERSONALIZE EVERYTHING**: Every response should reference her specific data when available. Generic advice is only acceptable if no data exists.`
      } else {
        userCycleContext += `\n\nIMPORTANT: The user has NOT entered any data in the app yet (no periods, symptoms, moods, or notes tracked). If they ask about their personal patterns, cycle predictions, or their own symptoms, you should say: "I notice you haven't updated your period and symptom information in the app yet. To give you personalized insights about your cycle patterns and provide advice tailored specifically to you, please log your periods, symptoms, moods, and notes in the app first. However, I'm still here to help you with tips and guidance for what you're experiencing right now!"`
      }
    }
    
    // Add symptom context from current chat if provided
    let enhancedSystemPrompt = systemPrompt.replace('${userName}', userName)
    if (symptoms && symptoms.length > 0) {
      const symptomsList = symptoms
        .map((s) => `${s.symptom} (${s.severity?.replace('_', ' ') || 'moderate'})`)
        .join(', ')
      enhancedSystemPrompt += `\n\nCURRENT CHAT CONTEXT: The user just mentioned/tracked these symptoms: ${symptomsList}. Address these specifically in your response.`
    }
    
    enhancedSystemPrompt += userCycleContext

    // Build the conversation history for Gemini (limit to last 10 messages)
    const recentMessages = messages.slice(-10)
    const conversationHistory = []
    
    for (const msg of recentMessages) {
      if (msg.role === 'user') {
        conversationHistory.push({
          role: 'user',
          parts: [{ text: msg.content }],
        })
      } else if (msg.role === 'assistant') {
        conversationHistory.push({
          role: 'model',
          parts: [{ text: msg.content }],
        })
      }
    }

    // Ensure there's at least one user message
    if (conversationHistory.length === 0 && messages.length > 0) {
      const lastMessage = messages[messages.length - 1]
      if (lastMessage.role === 'user') {
        conversationHistory.push({
          role: 'user',
          parts: [{ text: lastMessage.content }],
        })
      }
    }

    if (conversationHistory.length === 0 || conversationHistory[conversationHistory.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'No user message found in conversation history' })
    }

    // Initialize Gemini client
    const genAI = getGeminiClient()
    
    // Use fastest model first - gemini-2.5-flash is fastest
    const modelNames = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-2.5-pro', 'gemini-pro-latest']
    
    let result
    let lastError = null
    
    // Retry logic helper function
    const tryWithRetry = async (modelName, maxRetries = 2) => {
      let attempt = 0
      while (attempt < maxRetries) {
        try {
          const model = genAI.getGenerativeModel({ 
            model: modelName, 
            systemInstruction: enhancedSystemPrompt,
          })
          
          if (attempt > 0) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
            console.log(`Retrying ${modelName} after ${delay}ms (attempt ${attempt + 1}/${maxRetries})`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }
          
          const response = await model.generateContent({
            contents: conversationHistory,
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 8192,
              topP: 0.9,
              topK: 40,
            },
          })
          
          console.log(`✅ Successfully got response from Gemini model: ${modelName}`)
          return response
        } catch (error) {
          const errorStatus = error?.status || 0
          const errorMsg = error?.message || error?.statusText || 'Unknown error'
          
          if ((errorStatus === 503 || errorStatus === 429 || errorMsg.includes('503') || errorMsg.includes('overloaded') || errorMsg.includes('rate limit')) && attempt < maxRetries - 1) {
            attempt++
            console.log(`⚠️ ${modelName} returned ${errorStatus} (overloaded/rate limited), will retry...`)
            continue
          }
          
          if (errorStatus === 404 || errorMsg.includes('404') || errorMsg.toLowerCase().includes('not found')) {
            throw { ...error, isModelNotFound: true }
          }
          
          if (attempt < maxRetries - 1) {
            attempt++
            continue
          }
          
          throw error
        }
      }
    }
    
    for (const modelName of modelNames) {
      try {
        console.log(`Trying Gemini model: ${modelName}`)
        result = await tryWithRetry(modelName)
        break
      } catch (error) {
        const errorMsg = error?.message || error?.statusText || 'Unknown error'
        const errorStatus = error?.status || 0
        console.log(`❌ Failed with ${modelName}:`, errorMsg, `(Status: ${errorStatus})`)
        lastError = error
        
        if (error?.isModelNotFound || errorStatus === 404 || errorStatus === 503 || errorStatus === 429 || 
            errorMsg.includes('404') || errorMsg.includes('503') || errorMsg.toLowerCase().includes('not found')) {
          console.log(`Model ${modelName} not available or overloaded, trying next...`)
          if (modelName === modelNames[modelNames.length - 1]) {
            throw new Error(`All Gemini models failed. Please verify your API key has access to Generative Language API. Last error: ${errorMsg}`)
          }
          continue
        } else {
          throw error
        }
      }
    }

    if (!result) {
      throw lastError || new Error('Failed to get response from any Gemini model')
    }

    const responseContent = result.response.text() || 'I apologize, but I\'m having trouble right now. Please try again.'

    return res.json({ message: responseContent })
  } catch (error) {
    console.error('Chat error:', error)
    
    let errorMessage = 'Failed to get chat response'
    let statusCode = 500
    
    const errorStatus = error?.status || 0
    const errorMsg = error?.message || ''
    
    if (errorStatus === 503 || errorMsg.includes('503') || errorMsg.includes('overloaded')) {
      errorMessage = 'AI service is temporarily overloaded. Please try again in a moment.'
      statusCode = 503
    } else if (errorStatus === 429 || errorMsg.includes('rate limit')) {
      errorMessage = 'AI service is busy. Please try again in a moment.'
      statusCode = 429
    } else if (errorStatus === 404 || errorMsg.includes('404') || errorMsg.toLowerCase().includes('not found')) {
      errorMessage = 'AI model not found. Please check API configuration.'
      statusCode = 404
    } else if (errorMsg.includes('API key') || errorStatus === 401 || errorStatus === 403) {
      errorMessage = 'AI service configuration error. Please contact support.'
      statusCode = 500
    } else if (errorMsg) {
      errorMessage = process.env.NODE_ENV === 'development' 
        ? `Failed to get chat response: ${errorMsg}` 
        : 'Failed to get chat response. Please try again.'
    }
    
    return res.status(statusCode).json({ 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? {
        message: error?.message,
        stack: error?.stack,
      } : undefined
    })
  }
})

export default router

