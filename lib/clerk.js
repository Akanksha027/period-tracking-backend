import { clerkClient } from '@clerk/clerk-sdk-node'
import dotenv from 'dotenv'

dotenv.config()

const clerkSecretKey = process.env.CLERK_SECRET_KEY

// Lazy initialization - only create client when accessed
let _clerkClient = null

function getClerkClient() {
  if (!clerkSecretKey) {
    throw new Error('Missing CLERK_SECRET_KEY environment variable')
  }
  
  if (!_clerkClient) {
    // Clerk SDK automatically uses CLERK_SECRET_KEY from environment
    // But we can also pass it explicitly if needed
    _clerkClient = clerkClient()
  }
  
  return _clerkClient
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
