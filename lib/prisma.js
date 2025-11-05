import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'

dotenv.config()

const globalForPrisma = globalThis

let prisma = null

function getPrisma() {
  if (!prisma) {
    if (process.env.NODE_ENV === 'production') {
      prisma = new PrismaClient({
        log: ['error', 'warn'],
      })
    } else {
      if (!globalForPrisma.prisma) {
        globalForPrisma.prisma = new PrismaClient({
          log: ['query', 'error', 'warn'],
        })
      }
      prisma = globalForPrisma.prisma
    }

    // Graceful shutdown
    if (typeof process !== 'undefined') {
      process.on('beforeExit', async () => {
        await prisma.$disconnect()
      })
    }
  }
  return prisma
}

// Export a proxy that initializes Prisma only when accessed
const prismaProxy = new Proxy({}, {
  get(target, prop) {
    const prismaInstance = getPrisma()
    const value = prismaInstance[prop]
    // If it's a function, bind it to the instance
    if (typeof value === 'function') {
      return value.bind(prismaInstance)
    }
    return value
  }
})

export default prismaProxy
