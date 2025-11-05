import app from '../server.js'

// Handle cron job endpoint separately
export default async function handler(req, res) {
  // Check if this is a cron request
  if (req.url === '/api/cron/reminders' || req.url === '/cron/reminders') {
    // Import and handle cron job
    const cronHandler = (await import('./cron/reminders.js')).default
    return cronHandler(req, res)
  }
  
  // Otherwise, use the main app
  return app(req, res)
}
