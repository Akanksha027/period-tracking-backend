import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

// Helper function to check and throw if env vars are missing
function ensureEnvVars() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase environment variables')
  }
}

// Lazy initialization - only create clients when accessed
let _supabase = null
let _supabaseAdmin = null

// Client for user operations (uses anon key)
function getSupabase() {
  ensureEnvVars()
  if (!_supabase) {
    _supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: false, // We'll handle sessions manually
      },
    })
  }
  return _supabase
}

// Admin client for server-side operations (uses service role key)
function getSupabaseAdmin() {
  ensureEnvVars()
  if (!supabaseServiceRoleKey) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY environment variable')
  }
  if (!_supabaseAdmin) {
    _supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }
  return _supabaseAdmin
}

// Export getters that will throw only when actually used
export const supabase = new Proxy({}, {
  get(target, prop) {
    return getSupabase()[prop]
  }
})

export const supabaseAdmin = new Proxy({}, {
  get(target, prop) {
    return getSupabaseAdmin()[prop]
  }
})

export default supabase
