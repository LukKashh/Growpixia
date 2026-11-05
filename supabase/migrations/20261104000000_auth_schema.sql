-- Case-insensitive unique index on profiles username
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_idx ON public.profiles (LOWER(username));

-- Recovery codes table
CREATE TABLE IF NOT EXISTS public.recovery_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    redeemed_at TIMESTAMPTZ
);

-- Enable RLS on recovery_codes
ALTER TABLE public.recovery_codes ENABLE ROW LEVEL SECURITY;

-- RLS policies for recovery_codes (only service role or admin functions can access)
CREATE POLICY "Service role full access on recovery_codes" ON public.recovery_codes
    FOR ALL USING (auth.role() = 'service_role');
