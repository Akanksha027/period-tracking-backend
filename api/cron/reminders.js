/**
 * Vercel Cron Job endpoint for sending reminders
 * This runs every 3 hours automatically via Vercel Cron
 * Schedule: "0 */3 * * *" (every 3 hours)
 */

import sendRemindersToUsers from '../../jobs/sendReminders.js'

export default async function handler(req, res) {
  // Verify it's a cron request (Vercel adds this header)
  // For now, we'll allow it without authentication for simplicity
  // In production, you can add CRON_SECRET check:
  // if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ error: 'Unauthorized' })
  // }

  try {
    console.log('[Cron Reminders] Starting cron job at', new Date().toISOString())
    const results = await sendRemindersToUsers()
    
    console.log('[Cron Reminders] Job completed:', results)
    
    return res.status(200).json({
      success: true,
      results,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[Cron Reminders] Error:', error)
    return res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    })
  }
}

