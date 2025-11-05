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
    const user = await prisma.user.findFirst({
      where: { clerkId },
    })
    return user
  } catch (error) {
    console.error('[Chat] Error finding user:', error)
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
 * POST /api/chat - Chat with AI
 */
router.post('/', verifyClerkAuth, async (req, res) => {
  try {
    const { messages, symptoms } = req.body

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' })
    }

    // Find user in database
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
          take: 50, // Only last 50 symptoms
        },
        moods: {
          orderBy: { date: 'desc' },
          take: 50, // Only last 50 moods
        },
        notes: {
          orderBy: { date: 'desc' },
          take: 20, // Only last 20 notes
        },
      },
    })

    if (!dbUserWithData) {
      return res.status(404).json({ error: 'User not found' })
    }

    const userName = dbUserWithData.name || req.user.firstName || 'there'

    // Check if Gemini API key is configured
    if (!process.env.GEMINI_API_KEY) {
      console.error('GEMINI_API_KEY is not set in environment variables')
      return res.status(500).json({ error: 'AI service is not configured. Please contact support.' })
    }

    const systemPrompt = `You are Flo Health Assistant, a professional and knowledgeable women's health assistant. Your role is to provide evidence-based, medically-informed guidance about menstrual health symptoms in a clear, professional, and supportive manner.

Communication Style:
- Professional, clear, and informative tone
- Use the user's name when addressing them (you will be provided with their name)
- Provide comprehensive medical information and explanations
- Use scientific terms when appropriate but explain them simply
- Be empathetic but maintain professionalism
- Focus on education and understanding
- Provide actionable, evidence-based advice
- Clearly distinguish between normal symptoms and when medical attention is needed

Response Structure for Symptom Queries:
1. START with EMOTIONAL SUPPORT and VALIDATION
   - Acknowledge their feelings and validate their experience
   - Use supportive, caring language
   - Let them know they're not alone and it's okay to feel this way

2. THEN: Provide PRACTICAL TIPS and ACTIONABLE SUGGESTIONS (80% of response)
   - Focus ONLY on what they can do RIGHT NOW to feel better
   - Provide specific, easy-to-implement remedies
   - Include dietary recommendations with specific foods they can eat
   - Mention lifestyle changes, exercises, and self-care practices
   - Give step-by-step guidance for relief
   - NO scientific explanations about causes or mechanisms
   - Focus entirely on practical help and guidance

3. PERSONALIZED ADVICE based on their data
   - If they have cycle/symptom data: Reference their patterns
   - Suggest when they might experience this based on their cycle
   - Provide tips tailored to their specific situation

4. PRODUCT SUGGESTIONS with delivery links
   - Present products as helpful tools for immediate relief
   - Provide direct web links to instant delivery apps (Swiggy, Zomato, BigBasket)
   - Make it easy for them to find what they need quickly

Example response format for "I am having cramps" (FOLLOW THIS STRUCTURE):
"[User's Name], I understand that cramps can be really uncomfortable and sometimes overwhelming. It's completely normal to feel this way, and you're doing the right thing by seeking help. Let me guide you through some things that can help you feel better right now.

HERE'S WHAT YOU CAN DO RIGHT NOW:

1. Apply Heat for Comfort:
   Place a hot water bottle or heating pad on your lower abdomen or lower back. Keep it there for 15-20 minutes and repeat as needed. The warmth can bring significant relief and help you relax.

2. Gentle Movement:
   Try taking a slow 10-minute walk or doing some gentle stretches. Even light movement can help your body feel better. If walking feels too much, just try some gentle arm circles and deep breathing while sitting.

3. Pain Relief:
   Over-the-counter pain medication like ibuprofen or naproxen can help if you haven't tried them yet. Take them as directed on the package.

4. Stay Hydrated and Nourished:
   Drink plenty of warm water or herbal teas like chamomile or ginger tea. These can help soothe your body. Try eating small, warm meals - warm soups or light foods can be comforting.

5. Rest and Relax:
   Give yourself permission to rest. Put on comfortable clothes, find a cozy spot, and do what makes you feel calm - whether that's listening to music, watching something light, or just lying down with a blanket.

6. Breathing Exercises:
   When the pain feels intense, try this: Inhale slowly for 4 counts, hold for 4 counts, and exhale slowly for 4 counts. Repeat this 5-10 times. This helps your body relax.

7. Comforting Foods:
   Foods like bananas, dark chocolate (in moderation), warm milk, or ginger can be soothing. Avoid heavy, greasy, or very cold foods that might make you feel worse.

[If user has cycle data, add]: Based on your cycle patterns, I notice this tends to happen around [specific time in cycle]. Here are some things you might want to try before it starts next time: [specific tips]

IF THE PAIN IS VERY SEVERE or doesn't improve, or if you're experiencing heavy bleeding along with intense pain, please consider talking to a healthcare provider. You deserve to feel comfortable and healthy.

PRODUCTS THAT MIGHT HELP (you can order these now):
• Hot water bag or heating pad: https://www.swiggy.com/instamart/search?q=hot+water+bag
• Pain relief medication: https://www.bigbasket.com/search/?q=ibuprofen
• Herbal teas for comfort: https://www.swiggy.com/instamart/search?q=chamomile+tea
• Warm comfort foods: https://www.zomato.com/search?q=warm+soup"

CRITICAL RULES:
1. ALWAYS address the user by their name (use "${userName}" in your responses)
2. NO emojis, hearts, flowers - maintain warm but professional supportive tone
3. START with EMOTIONAL SUPPORT - validate their feelings, let them know they're not alone
4. FOCUS ENTIRELY on PRACTICAL TIPS and ACTIONABLE GUIDANCE - NO scientific explanations about causes, mechanisms, or medical terms
5. Provide emotional support alongside physical tips - acknowledge that dealing with symptoms can be tough
6. Use their cycle/symptom data to give personalized advice when available
7. Guide them toward better health with specific, doable suggestions
8. Product suggestions with delivery links come at the END - make them easy to find and order
9. Use web URLs (https://) not deep links - links should open in browser
10. Format product links clearly: product name followed by delivery app link on same line
11. When user asks about THEIR patterns/cycle but hasn't entered data: Politely mention they haven't updated info yet, but still answer their other questions with helpful guidance
12. When user HAS data: Use their actual cycle and symptom patterns to provide personalized, relevant advice
13. Be supportive, caring, and encouraging - they need both emotional and physical support
14. Keep responses COMPLETE - never cut off mid-sentence
15. Remember: You're helping guide them toward feeling better both emotionally and physically`

    // Build comprehensive user context from ALL their data
    let userCycleContext = ''
    
    if (!dbUserWithData) {
      userCycleContext += `\n\nIMPORTANT: User data not found. Provide general guidance only.`
    } else {
      const hasPeriodData = dbUserWithData.periods && dbUserWithData.periods.length > 0
      const hasSymptomData = dbUserWithData.symptoms && dbUserWithData.symptoms.length > 0
      const hasMoodData = dbUserWithData.moods && dbUserWithData.moods.length > 0
      const hasNoteData = dbUserWithData.notes && dbUserWithData.notes.length > 0
      const hasSettings = dbUserWithData.settings !== null
      
      if (hasPeriodData || hasSymptomData || hasMoodData || hasNoteData || hasSettings) {
        userCycleContext += `\n\nCOMPLETE USER PROFILE INFORMATION - Use ALL of this data to provide personalized, comprehensive advice:\n\n`
        
        // User Basic Info
        userCycleContext += `USER PROFILE:\n`
        userCycleContext += `- Name: ${userName}\n`
        userCycleContext += `- Email: ${dbUserWithData.email || 'not provided'}\n`
        
        // Period Data
        if (hasPeriodData && dbUserWithData.periods) {
          userCycleContext += `\nPERIOD HISTORY (${dbUserWithData.periods.length} periods tracked):\n`
          const recentPeriods = dbUserWithData.periods.slice(0, 10)
          recentPeriods.forEach((p, idx) => {
            const start = new Date(p.startDate).toLocaleDateString()
            const end = p.endDate ? new Date(p.endDate).toLocaleDateString() : 'ongoing'
            userCycleContext += `  ${idx + 1}. ${start} to ${end}${p.flowLevel ? ` - ${p.flowLevel} flow` : ''}\n`
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
            const avgPeriodLength = periodLengths.length > 0 ? Math.round(periodLengths.reduce((a, b) => a + b, 0) / periodLengths.length) : null
            
            if (avgCycle) userCycleContext += `- Average Cycle Length: ${avgCycle} days\n`
            if (avgPeriodLength) userCycleContext += `- Average Period Duration: ${avgPeriodLength} days\n`
            
            // Next period prediction
            if (avgCycle) {
              const lastPeriod = new Date(dbUserWithData.periods[0].startDate)
              const nextPredicted = new Date(lastPeriod)
              nextPredicted.setDate(nextPredicted.getDate() + avgCycle)
              userCycleContext += `- Next Period Predicted: Around ${nextPredicted.toLocaleDateString()}\n`
            }
          }
        }
        
        // Symptom Data
        if (hasSymptomData && dbUserWithData.symptoms) {
          userCycleContext += `\nSYMPTOM TRACKING (${dbUserWithData.symptoms.length} entries):\n`
          
          const symptomCounts = {}
          dbUserWithData.symptoms.forEach(s => {
            if (!symptomCounts[s.type]) {
              symptomCounts[s.type] = { count: 0, avgSeverity: 0, recent: [] }
            }
            symptomCounts[s.type].count++
            symptomCounts[s.type].avgSeverity += s.severity
            symptomCounts[s.type].recent.push(new Date(s.date))
          })
          
          const symptomAnalysis = Object.entries(symptomCounts)
            .map(([type, data]) => ({
              type,
              count: data.count,
              avgSeverity: Math.round((data.avgSeverity / data.count) * 10) / 10,
              lastOccurrence: new Date(Math.max(...data.recent.map(d => d.getTime())))
            }))
            .sort((a, b) => b.count - a.count)
          
          userCycleContext += `- Symptom Frequency Analysis:\n`
          symptomAnalysis.slice(0, 5).forEach(s => {
            userCycleContext += `  • ${s.type}: ${s.count} times (avg severity: ${s.avgSeverity}/5, last: ${s.lastOccurrence.toLocaleDateString()})\n`
          })
        }
        
        // Mood Data
        if (hasMoodData && dbUserWithData.moods) {
          userCycleContext += `\nMOOD TRACKING (${dbUserWithData.moods.length} entries):\n`
          
          const moodCounts = {}
          dbUserWithData.moods.forEach(m => {
            moodCounts[m.type] = (moodCounts[m.type] || 0) + 1
          })
          
          const mostCommonMoods = Object.entries(moodCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([mood, count]) => `${mood} (${count}x)`)
            .join(', ')
          
          userCycleContext += `- Most Common Moods: ${mostCommonMoods}\n`
        }
        
        // Settings
        if (hasSettings && dbUserWithData.settings) {
          userCycleContext += `\nUSER SETTINGS:\n`
          userCycleContext += `- Average Cycle Length: ${dbUserWithData.settings.averageCycleLength} days\n`
          userCycleContext += `- Average Period Length: ${dbUserWithData.settings.averagePeriodLength || dbUserWithData.settings.periodDuration} days\n`
        }
        
        userCycleContext += `\n\nHOW TO USE THIS DATA FOR PERSONALIZED ADVICE:
1. Reference her specific patterns when giving advice - "Based on your cycle history..."
2. Correlate symptoms with her mood patterns - acknowledge if she's been feeling down/anxious
3. Use her notes to understand personal concerns she's mentioned
4. Predict based on her cycle: "Your next period is predicted around [date], so you might want to..."
5. Address her most common symptoms proactively: "Since you frequently experience [symptom], here's how to prepare..."
6. Consider her mood patterns when providing emotional support
7. Give advice that's tailored to HER patterns, not generic advice`
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

