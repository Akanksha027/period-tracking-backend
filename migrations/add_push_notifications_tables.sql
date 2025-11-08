-- Create table to store Expo push tokens for each device/login context
CREATE TABLE IF NOT EXISTS "push_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expo_push_token" TEXT NOT NULL,
    "device_type" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "viewed_user_id" TEXT,
    "timezone_offset_minutes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "push_tokens_expo_push_token_key" ON "push_tokens"("expo_push_token");
CREATE INDEX IF NOT EXISTS "push_tokens_user_id_idx" ON "push_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "push_tokens_viewed_user_id_idx" ON "push_tokens"("viewed_user_id");

ALTER TABLE "push_tokens"
ADD CONSTRAINT "push_tokens_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Table to log notifications that were sent (for rate limiting and history)
CREATE TABLE IF NOT EXISTS "notification_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "viewer_user_id" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notification_logs_user_audience_category_idx"
ON "notification_logs"("user_id", "audience", "category", "sent_at");

CREATE INDEX IF NOT EXISTS "notification_logs_viewer_user_idx"
ON "notification_logs"("viewer_user_id");

ALTER TABLE "notification_logs"
ADD CONSTRAINT "notification_logs_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

