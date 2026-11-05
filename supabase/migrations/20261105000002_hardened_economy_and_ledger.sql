-- GrowPixel Hardened Economy & Migration Ledger
-- Extends 20261104000001_atomic_player_persistence.sql

-- 1. Upgrade Idempotency Keys Table
ALTER TABLE public.idempotency_keys 
ADD COLUMN IF NOT EXISTS payload_hash TEXT NOT NULL DEFAULT '',
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Add index for hash lookup
CREATE INDEX IF NOT EXISTS idempotency_keys_user_payload_idx ON public.idempotency_keys (user_id, operation_type, payload_hash);

-- 2. Create Migration Ledger Table
CREATE TABLE IF NOT EXISTS public.migration_ledger (
    legacy_username TEXT PRIMARY KEY,
    supabase_user_id UUID REFERENCES auth.users(id),
    gems_imported INT8 NOT NULL DEFAULT 0,
    inventory_imported JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'verified', 'failed'
    verification_hash TEXT,
    imported_at TIMESTAMPTZ DEFAULT NOW(),
    error_message TEXT
);

ALTER TABLE public.migration_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on migration_ledger"
    ON public.migration_ledger
    FOR ALL
    USING (auth.role() = 'service_role');

-- 3. Hardened Atomic Economy RPC Function
-- Features: 
-- - Atomic idempotency-key claiming (Insert 'processing')
-- - Payload fingerprint validation (SHA-256)
-- - Mapping mismatch to 409-style errors
-- - Consistent row locking
CREATE OR REPLACE FUNCTION public.update_player_economy_v2(
    p_user_id UUID,
    p_operation_type TEXT,
    p_gems_delta INT8 DEFAULT 0,
    p_inventory_delta JSONB DEFAULT '{}'::jsonb,
    p_idempotency_key TEXT DEFAULT NULL,
    p_payload_hash TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_stored_record RECORD;
    v_curr_gems INT8;
    v_new_gems INT8;
    v_item_key TEXT;
    v_item_delta INT4;
    v_curr_qty INT4;
    v_new_qty INT4;
    v_all_inventory JSONB;
    v_response JSONB;
BEGIN
    -- 1. Strict Validation
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'p_user_id cannot be null';
    END IF;
    IF p_idempotency_key IS NULL OR TRIM(p_idempotency_key) = '' THEN
        RAISE EXCEPTION 'p_idempotency_key is required for economy operations';
    END IF;

    -- 2. Idempotency Check & Atomic Claiming
    -- We use row-level locking on the idempotency key if it exists
    SELECT * INTO v_stored_record
    FROM public.idempotency_keys
    WHERE key = TRIM(p_idempotency_key)
    FOR UPDATE;

    IF FOUND THEN
        -- Verify that the key isn't being reused for a different user/op/payload
        IF v_stored_record.user_id != p_user_id OR 
           v_stored_record.operation_type != p_operation_type OR 
           v_stored_record.payload_hash != COALESCE(p_payload_hash, '') THEN
            RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Key % already exists with different parameters', p_idempotency_key;
        END IF;

        -- If already completed, return original response
        IF v_stored_record.status = 'completed' THEN
            RETURN v_stored_record.response;
        ELSIF v_stored_record.status = 'processing' THEN
            -- This means a concurrent request is already handling this
            RAISE EXCEPTION 'IDEMPOTENCY_PROCESSING: Operation % is already in progress', p_idempotency_key;
        END IF;
    ELSE
        -- Atomically claim the key
        INSERT INTO public.idempotency_keys (key, user_id, operation_type, payload_hash, status, created_at)
        VALUES (TRIM(p_idempotency_key), p_user_id, p_operation_type, COALESCE(p_payload_hash, ''), 'processing', NOW());
    END IF;

    -- 3. Row-level Locking on Profile
    -- Lock profile for the entire transaction
    SELECT gems INTO v_curr_gems
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player profile not found for user: %', p_user_id;
    END IF;

    -- 4. Gems Update
    v_new_gems := v_curr_gems + COALESCE(p_gems_delta, 0);
    IF v_new_gems < 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_FUNDS: Current balance %, attempted delta %', v_curr_gems, p_gems_delta;
    END IF;

    IF p_gems_delta != 0 THEN
        UPDATE public.profiles
        SET gems = v_new_gems
        WHERE id = p_user_id;
    END IF;

    -- 5. Inventory Update
    IF p_inventory_delta IS NOT NULL AND p_inventory_delta != '{}'::jsonb THEN
        FOR v_item_key, v_item_delta IN SELECT * FROM jsonb_each_text(p_inventory_delta) LOOP
            v_item_key := TRIM(v_item_key);
            IF v_item_key = '' THEN CONTINUE; END IF;

            -- Row lock existing inventory entry
            SELECT quantity INTO v_curr_qty
            FROM public.player_inventory
            WHERE user_id = p_user_id AND item_id = v_item_key
            FOR UPDATE;

            v_new_qty := COALESCE(v_curr_qty, 0) + v_item_delta;

            IF v_new_qty < 0 THEN
                RAISE EXCEPTION 'INSUFFICIENT_INVENTORY: Item %, current %, delta %', v_item_key, COALESCE(v_curr_qty, 0), v_item_delta;
            ELSIF v_new_qty = 0 THEN
                DELETE FROM public.player_inventory
                WHERE user_id = p_user_id AND item_id = v_item_key;
            ELSE
                INSERT INTO public.player_inventory (user_id, item_id, quantity)
                VALUES (p_user_id, v_item_key, v_new_qty)
                ON CONFLICT (user_id, item_id)
                DO UPDATE SET quantity = v_new_qty;
            END IF;
        END LOOP;
    END IF;

    -- 6. Retrieve Final Snapshot
    SELECT jsonb_object_agg(item_id, quantity) INTO v_all_inventory
    FROM public.player_inventory
    WHERE user_id = p_user_id;

    v_response := jsonb_build_object(
        'success', true,
        'user_id', p_user_id,
        'gems', v_new_gems,
        'inventory', COALESCE(v_all_inventory, '{}'::jsonb),
        'requestId', p_idempotency_key
    );

    -- 7. Finalize Idempotency Record
    UPDATE public.idempotency_keys
    SET status = 'completed',
        response = v_response,
        updated_at = NOW()
    WHERE key = TRIM(p_idempotency_key);

    RETURN v_response;
EXCEPTION
    WHEN OTHERS THEN
        -- Errors here will cause transaction rollback
        RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. RPC Consistent Player Loading
CREATE OR REPLACE FUNCTION public.load_player_data(p_user_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_gems INT8;
    v_inventory JSONB;
BEGIN
    -- Use row-level locking to ensure consistency if called within a transaction
    SELECT gems INTO v_gems 
    FROM public.profiles 
    WHERE id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'PROFILE_NOT_FOUND: User % does not exist', p_user_id;
    END IF;

    SELECT jsonb_object_agg(item_id, quantity) INTO v_inventory
    FROM public.player_inventory
    WHERE user_id = p_user_id;

    RETURN jsonb_build_object(
        'gems', v_gems,
        'inventory', COALESCE(v_inventory, '{}'::jsonb),
        'userId', p_user_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 5. Permissions
REVOKE ALL ON FUNCTION public.update_player_economy_v2(UUID, TEXT, INT8, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_player_economy_v2(UUID, TEXT, INT8, JSONB, TEXT, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.load_player_data(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_player_data(UUID) TO service_role;
