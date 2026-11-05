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
    const hmacSecret = Deno.env.get("AUTH_HMAC_SECRET");
    if (!hmacSecret) {
      return new Response(JSON.stringify({ error: "Server configuration error: AUTH_HMAC_SECRET is missing." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { username, password, confirmPassword } = await req.json();

    if (!cleanUser || cleanUser.length < 3 || cleanUser.length > 16 || !/^[a-z0-9_-]+$/.test(cleanUser)) {
      return new Response(JSON.stringify({ error: "Username must be 3-16 alphanumeric characters, hyphens, or underscores." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!password || password.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters long." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (password !== confirmPassword) {
      return new Response(JSON.stringify({ error: "Passwords do not match." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    // Check case-insensitive uniqueness in public.profiles
    const { data: existingUser } = await supabaseAdmin
      .from("profiles")
      .select("username")
      .ilike("username", cleanUser)
      .maybeSingle();

    if (existingUser) {
      return new Response(JSON.stringify({ error: "Username is already taken." }), {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // HMAC internal identifier generation using verified secret
    const keyData = new TextEncoder().encode(hmacSecret);
    const msgData = new TextEncoder().encode(cleanUser);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
    const hexSig = encodeHex(signature);
    const internalEmail = `user_${hexSig}@growpixel.internal`;

    // Create Supabase Auth User (handle_new_user trigger creates public.profiles automatically)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: internalEmail,
      password: password,
      email_confirm: true,
      user_metadata: { username: username.trim() }
    });

    if (authError || !authData.user) {
      return new Response(JSON.stringify({ error: authError?.message || "Account creation failed." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = authData.user.id;

    // Verify or update trigger-created profile username with correct casing
    await supabaseAdmin
      .from("profiles")
      .update({ username: username.trim() })
      .eq("id", userId);

    // Generate cryptographic recovery code and store its SHA-256 hash
    const rawRecoveryBytes = crypto.getRandomValues(new Uint8Array(16));
    const recoveryCode = encodeHex(rawRecoveryBytes);
    
    const codeHashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recoveryCode));
    const codeHash = encodeHex(codeHashBytes);

    const { error: recoveryError } = await supabaseAdmin
      .from("recovery_codes")
      .insert({
        user_id: userId,
        code_hash: codeHash,
      });

    if (recoveryError) {
      console.warn("Failed to store recovery code:", recoveryError);
    }

    // Generate session token via signInWithPassword
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    const { data: sessionData, error: sessionError } = await supabaseClient.auth.signInWithPassword({
      email: internalEmail,
      password: password,
    });

    if (sessionError || !sessionData.session) {
      return new Response(JSON.stringify({ error: "Authentication session creation failed." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        session: sessionData.session,
        user: {
          id: userId,
          username: username.trim(),
          gems: 0,
        },
        recoveryCode,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
