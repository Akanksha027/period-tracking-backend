import { clerkClient } from '@clerk/clerk-sdk-node'
import dotenv from 'dotenv'

dotenv.config()

const clerkSecretKey = process.env.CLERK_SECRET_KEY

// Lazy initialization - clerkClient is already the initialized client object
// We just need to ensure the secret key is set in environment
function getClerkClient() {
  if (!clerkSecretKey) {
    // Don't throw error - just log and return null to prevent crashes
    console.warn('[Clerk] Missing CLERK_SECRET_KEY environment variable')
    return null
  }

  try {
    // Ensure the secret key is set in process.env for Clerk SDK
    if (clerkSecretKey && !process.env.CLERK_SECRET_KEY) {
      process.env.CLERK_SECRET_KEY = clerkSecretKey
    }
    
    // clerkClient is already the initialized client object in v4+
    // It automatically uses CLERK_SECRET_KEY from environment
    return clerkClient
  } catch (error) {
    console.error('[Clerk] Error accessing client:', error)
    throw error
  }
}

// Export a proxy that initializes Clerk only when accessed
export const clerk = new Proxy({}, {
  get(target, prop) {
    const client = getClerkClient()
    const value = client[prop]
    // If it's a function, bind it to the client
    if (typeof value === 'function') {
      return value.bind(client)
    }
    return value
  }
})

export default clerk
