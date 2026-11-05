import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.168.0/crypto/mod.ts";
import { encodeHex } from "https://deno.land/std@0.168.0/encoding/hex.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { recoveryCode, newPassword } = await req.json();

    if (!recoveryCode || !newPassword || newPassword.length < 8) {
      return new Response(JSON.stringify({ error: "Invalid recovery code or password (minimum 8 characters required)." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    // Hash provided recovery code
    const codeHashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recoveryCode));
    const codeHash = encodeHex(codeHashBytes);

    // Look up unredeemed recovery code
    const { data: record, error: lookupError } = await supabaseAdmin
      .from("recovery_codes")
      .select("*")
      .eq("code_hash", codeHash)
      .is("redeemed_at", null)
      .maybeSingle();

    if (lookupError || !record) {
      return new Response(JSON.stringify({ error: "Invalid or already redeemed recovery code." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Atomically mark recovery code as redeemed
    const { error: updateError } = await supabaseAdmin
      .from("recovery_codes")
      .update({ redeemed_at: new Date().toISOString() })
      .eq("id", record.id)
      .is("redeemed_at", null);

    if (updateError) {
      return new Response(JSON.stringify({ error: "Recovery code redemption failed. Please try again." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Update user password in Supabase Auth
    const { error: passwordError } = await supabaseAdmin.auth.admin.updateUserById(record.user_id, {
      password: newPassword,
    });

    if (passwordError) {
      return new Response(JSON.stringify({ error: "Failed to update account password." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ success: true, message: "Password successfully reset using recovery code." }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
