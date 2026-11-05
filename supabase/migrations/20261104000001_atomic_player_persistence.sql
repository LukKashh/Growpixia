-- GrowPixel Atomic Player Economy Persistence Migration
-- Schema: public.profiles (gems), public.player_inventory (user_id, item_id, quantity)

-- 1. Idempotency Keys Table
CREATE TABLE IF NOT EXISTS public.idempotency_keys (
    key TEXT PRIMARY KEY,
    operation_type TEXT NOT NULL,
    user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'completed',
    response JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on idempotency_keys
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

-- Service role full access policy on idempotency_keys
DROP POLICY IF EXISTS "Service role full access on idempotency_keys" ON public.idempotency_keys;
CREATE POLICY "Service role full access on idempotency_keys"
    ON public.idempotency_keys
    FOR ALL
    USING (auth.role() = 'service_role');

-- 2. Authoritative Atomic Economy RPC Function
-- Supports atomic incremental gems and inventory updates with row locking and idempotency
CREATE OR REPLACE FUNCTION public.update_player_economy(
    p_user_id UUID,
    p_gems_delta INT8 DEFAULT 0,
    p_inventory_delta JSONB DEFAULT '{}'::jsonb,
    p_idempotency_key TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
    v_stored_response JSONB;
    v_curr_gems INT8;
    v_new_gems INT8;
    v_item_key TEXT;
    v_item_delta_text TEXT;
    v_item_delta INT4;
    v_curr_qty INT4;
    v_new_qty INT4;
    v_all_inventory JSONB;
    v_response JSONB;
BEGIN
    -- 1. Validate Input User ID
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'p_user_id cannot be null';
    END IF;

    -- 2. Idempotency Check: Return previously computed result if key exists
    IF p_idempotency_key IS NOT NULL AND TRIM(p_idempotency_key) != '' THEN
        SELECT response INTO v_stored_response
        FROM public.idempotency_keys
        WHERE key = TRIM(p_idempotency_key) AND status = 'completed';

        IF FOUND AND v_stored_response IS NOT NULL THEN
            RETURN v_stored_response;
        END IF;
    END IF;

    -- 3. Row-level Locking on Profile
    SELECT gems INTO v_curr_gems
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Player profile not found for user: %', p_user_id;
    END IF;

    -- 4. Calculate & Validate Gems Balance
    v_new_gems := v_curr_gems + COALESCE(p_gems_delta, 0);
    IF v_new_gems < 0 THEN
        RAISE EXCEPTION 'Insufficient gems: current balance is %, attempted delta is %', v_curr_gems, p_gems_delta;
    END IF;

    IF p_gems_delta != 0 THEN
        UPDATE public.profiles
        SET gems = v_new_gems
        WHERE id = p_user_id;
    END IF;

    -- 5. Incremental Inventory Updates with Row-level Locking
    IF p_inventory_delta IS NOT NULL AND p_inventory_delta != '{}'::jsonb THEN
        FOR v_item_key, v_item_delta_text IN SELECT * FROM jsonb_each_text(p_inventory_delta) LOOP
            v_item_key := TRIM(v_item_key);
            IF v_item_key = '' THEN
                RAISE EXCEPTION 'Invalid item ID: cannot be blank';
            END IF;

            BEGIN
                v_item_delta := v_item_delta_text::INT4;
            EXCEPTION WHEN OTHERS THEN
                RAISE EXCEPTION 'Invalid quantity delta for item %: % is not a valid integer', v_item_key, v_item_delta_text;
            END;

            IF v_item_delta = 0 THEN
                CONTINUE;
            END IF;

            -- Row lock existing inventory entry
            SELECT quantity INTO v_curr_qty
            FROM public.player_inventory
            WHERE user_id = p_user_id AND item_id = v_item_key
            FOR UPDATE;

            v_new_qty := COALESCE(v_curr_qty, 0) + v_item_delta;

            IF v_new_qty < 0 THEN
                RAISE EXCEPTION 'Insufficient inventory for item %: current quantity is %, attempted delta is %',
                    v_item_key, COALESCE(v_curr_qty, 0), v_item_delta;
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

    -- 6. Retrieve Complete Authoritative Inventory Snapshot
    SELECT jsonb_object_agg(item_id, quantity) INTO v_all_inventory
    FROM public.player_inventory
    WHERE user_id = p_user_id;

    v_all_inventory := COALESCE(v_all_inventory, '{}'::jsonb);

    -- 7. Construct Authoritative Response Payload
    v_response := jsonb_build_object(
        'success', true,
        'user_id', p_user_id,
        'gems', v_new_gems,
        'inventory', v_all_inventory
    );

    -- 8. Store Idempotency Record within the same transaction
    IF p_idempotency_key IS NOT NULL AND TRIM(p_idempotency_key) != '' THEN
        INSERT INTO public.idempotency_keys (key, operation_type, user_id, status, response, created_at)
        VALUES (TRIM(p_idempotency_key), 'player_economy', p_user_id, 'completed', v_response, NOW())
        ON CONFLICT (key) DO UPDATE SET response = v_response, status = 'completed';
    END IF;

    RETURN v_response;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. Wrapper Function for Backward Compatibility
CREATE OR REPLACE FUNCTION public.update_player_data(
    p_user_id UUID,
    p_gems_delta INT8 DEFAULT 0,
    p_inventory_delta JSONB DEFAULT '{}'::jsonb
) RETURNS JSONB AS $$
BEGIN
    RETURN public.update_player_economy(p_user_id, p_gems_delta, p_inventory_delta, NULL);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4. Secure Privileged Execution Permissions
REVOKE ALL ON FUNCTION public.update_player_economy(UUID, INT8, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_player_economy(UUID, INT8, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.update_player_economy(UUID, INT8, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_player_economy(UUID, INT8, JSONB, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.update_player_data(UUID, INT8, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_player_data(UUID, INT8, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.update_player_data(UUID, INT8, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.update_player_data(UUID, INT8, JSONB) TO service_role;
