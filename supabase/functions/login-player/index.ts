import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function encodeHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const hmacSecret = Deno.env.get("AUTH_HMAC_SECRET");
    if (!hmacSecret) {
      return new Response(
        JSON.stringify({ error: "Server configuration error: AUTH_HMAC_SECRET is missing." }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const { username, password } = await req.json();
    const cleanUser = (username || "").trim().toLowerCase();

    if (!cleanUser || !password) {
      return new Response(
        JSON.stringify({ error: "Invalid username or password." }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } }
    );

    // Resolve internal email via Web Crypto API HMAC-SHA256 with verified secret
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

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    const { data: sessionData, error: sessionError } = await supabaseClient.auth.signInWithPassword({
      email: internalEmail,
      password: password,
    });

    if (sessionError || !sessionData.session || !sessionData.user) {
      // Use generic error response to prevent username enumeration
      return new Response(
        JSON.stringify({ error: "Invalid username or password." }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fetch public profile
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", sessionData.user.id)
      .single();

    return new Response(
      JSON.stringify({
        success: true,
        session: sessionData.session,
        user: profile || {
          id: sessionData.user.id,
          username: username.trim(),
          gems: 0,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: "Invalid username or password." }),
      {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
