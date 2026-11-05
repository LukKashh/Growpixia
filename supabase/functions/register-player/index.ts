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

    const { username, password, confirmPassword } = await req.json();

    const cleanUser = (username || "").trim().toLowerCase();
    if (!cleanUser || cleanUser.length < 3 || cleanUser.length > 16 || !/^[a-z0-9_-]+$/.test(cleanUser)) {
      return new Response(
        JSON.stringify({ error: "Username must be 3-16 alphanumeric characters, hyphens, or underscores." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (!password || password.length < 8) {
      return new Response(
        JSON.stringify({ error: "Password must be at least 8 characters long." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    if (password !== confirmPassword) {
      return new Response(
        JSON.stringify({ error: "Passwords do not match." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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
      return new Response(
        JSON.stringify({ error: "Username is already taken." }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // HMAC internal identifier generation using Web Crypto API & verified secret
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
      user_metadata: { username: username.trim() },
    });

    if (authError || !authData.user) {
      return new Response(
        JSON.stringify({ error: authError?.message || "Account creation failed." }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const userId = authData.user.id;

    // Helper for thoroughly cleaning up user and verifying table/auth removal upon post-auth step failure
    const rollbackUser = async (): Promise<boolean> => {
      let success = true;

      // 1. Delete associated recovery_codes records and check result
      try {
        const { error: recError } = await supabaseAdmin
          .from("recovery_codes")
          .delete()
          .eq("user_id", userId);

        if (recError) {
          console.error(`Rollback: Failed to delete recovery codes for user ${userId}:`, recError.message);
          success = false;
        }
      } catch (err: any) {
        console.error(`Rollback: Exception deleting recovery codes for user ${userId}:`, err?.message || err);
        success = false;
      }

      // 2. Delete associated profile record and check result
      try {
        const { error: profError } = await supabaseAdmin
          .from("profiles")
          .delete()
          .eq("id", userId);

        if (profError) {
          console.error(`Rollback: Failed to delete profile for user ${userId}:`, profError.message);
          success = false;
        }
      } catch (err: any) {
        console.error(`Rollback: Exception deleting profile for user ${userId}:`, err?.message || err);
        success = false;
      }

      // 3. Delete Supabase Auth user and check result
      try {
        const { error: delError } = await supabaseAdmin.auth.admin.deleteUser(userId);
        if (delError) {
          console.error(`Rollback: Failed to delete Auth user ${userId}:`, delError.message);
          success = false;
        }
      } catch (err: any) {
        console.error(`Rollback: Exception deleting Auth user ${userId}:`, err?.message || err);
        success = false;
      }

      // 4. Verify no recovery-code records remain for the newly created user
      try {
        const { data: recCheck, error: recCheckErr } = await supabaseAdmin
          .from("recovery_codes")
          .select("id")
          .eq("user_id", userId);

        if (recCheckErr) {
          console.error(`Rollback verification error (recovery_codes) for user ${userId}:`, recCheckErr.message);
          success = false;
        } else if (recCheck && recCheck.length > 0) {
          console.error(`Rollback verification failed: ${recCheck.length} recovery code record(s) still remain for user ${userId}`);
          success = false;
        }
      } catch (err: any) {
        console.error(`Rollback verification exception (recovery_codes) for user ${userId}:`, err?.message || err);
        success = false;
      }

      // 5. Verify no profile record remains
      try {
        const { data: profCheck, error: profCheckErr } = await supabaseAdmin
          .from("profiles")
          .select("id")
          .eq("id", userId)
          .maybeSingle();

        if (profCheckErr) {
          console.error(`Rollback verification error (profiles) for user ${userId}:`, profCheckErr.message);
          success = false;
        } else if (profCheck) {
          console.error(`Rollback verification failed: Profile still exists for user ${userId}`);
          success = false;
        }
      } catch (err: any) {
        console.error(`Rollback verification exception (profiles) for user ${userId}:`, err?.message || err);
        success = false;
      }

      // 6. Verify that Supabase Auth user was successfully deleted using Supabase Admin API
      try {
        const { data: authCheckData, error: authCheckErr } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (authCheckData?.user) {
          console.error(`Rollback verification failed: Supabase Auth user still exists for user ${userId}`);
          success = false;
        } else if (authCheckErr && !authCheckErr.message?.toLowerCase().includes("not found") && !authCheckErr.message?.toLowerCase().includes("invalid")) {
          console.error(`Rollback verification error (auth.admin.getUserById) for user ${userId}:`, authCheckErr.message);
          success = false;
        }
      } catch (err: any) {
        console.error(`Rollback verification exception (auth.admin.getUserById) for user ${userId}:`, err?.message || err);
        success = false;
      }

      return success;
    };

    // Verify or update trigger-created profile username with correct casing
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({ username: username.trim() })
      .eq("id", userId);

    if (profileError) {
      const cleaned = await rollbackUser();
      return new Response(
        JSON.stringify({
          error: cleaned
            ? "Profile configuration failed. Registration rolled back."
            : "Profile configuration failed and account cleanup was incomplete. Please contact support.",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Generate cryptographic recovery code using Web Crypto API and store its SHA-256 hash
    const rawRecoveryBytes = crypto.getRandomValues(new Uint8Array(16));
    const recoveryCode = encodeHex(rawRecoveryBytes);

    const codeHashBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(recoveryCode)
    );
    const codeHash = encodeHex(codeHashBytes);

    const { error: recoveryError } = await supabaseAdmin
      .from("recovery_codes")
      .insert({
        user_id: userId,
        code_hash: codeHash,
      });

    if (recoveryError) {
      const cleaned = await rollbackUser();
      return new Response(
        JSON.stringify({
          error: cleaned
            ? "Failed to store account recovery code. Registration rolled back."
            : "Failed to store recovery code and account cleanup was incomplete. Please contact support.",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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
      const cleaned = await rollbackUser();
      return new Response(
        JSON.stringify({
          error: cleaned
            ? "Authentication session creation failed. Registration rolled back."
            : "Session creation failed and account cleanup was incomplete. Please contact support.",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Registration failed." }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
