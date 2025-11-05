import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'

dotenv.config()

const globalForPrisma = globalThis

let prisma

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

export default prisma
