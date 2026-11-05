-- GrowPixel Final Hardened Economy RPC
-- Refines 20261105000002_hardened_economy_and_ledger.sql with single-transaction semantics

-- 1. Hardened Atomic Economy RPC Function v3
CREATE OR REPLACE FUNCTION public.update_player_economy_v3(
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

    -- 2. Atomic Idempotency Claim & Validation
    -- We use INSERT ... ON CONFLICT to ensure exactly one transaction handles the initial claim.
    -- If conflict, we lock the existing row to wait for the concurrent transaction to finish.
    INSERT INTO public.idempotency_keys (key, user_id, operation_type, payload_hash, status, created_at)
    VALUES (TRIM(p_idempotency_key), p_user_id, p_operation_type, COALESCE(p_payload_hash, ''), 'processing', NOW())
    ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
    RETURNING * INTO v_stored_record;

    -- Verify the record belongs to the same user/operation/payload
    IF v_stored_record.user_id != p_user_id OR 
       v_stored_record.operation_type != p_operation_type OR 
       v_stored_record.payload_hash != COALESCE(p_payload_hash, '') THEN
        RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT: Key % already exists with different parameters', p_idempotency_key;
    END IF;

    -- If already completed, return original response
    IF v_stored_record.status = 'completed' THEN
        RETURN v_stored_record.response;
    END IF;

    -- 3. Row-level Locking on Profile
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
        -- Standard PostgreSQL exception behavior will cause rollback of all changes,
        -- including the initial idempotency claim row if this was a new key.
        RAISE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- 2. Permissions
REVOKE ALL ON FUNCTION public.update_player_economy_v3(UUID, TEXT, INT8, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_player_economy_v3(UUID, TEXT, INT8, JSONB, TEXT, TEXT) TO service_role;
