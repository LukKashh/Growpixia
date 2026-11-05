# Android Supabase configuration

The Android app now reads its Supabase URL and **public publishable key** from
`android/local.properties` through Gradle BuildConfig.

1. Open `android/local.properties` (create it if it does not exist).
2. Keep any existing `sdk.dir=...` line.
3. Add these two lines, replacing the placeholder with the project's `sb_publishable_...` key from Supabase **Project Settings → API Keys**:

```properties
SUPABASE_URL=https://ydjynediqdmnosddwusw.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_REPLACE_WITH_YOUR_PROJECT_KEY
```

4. Sync Gradle and build the Android app.

`android/local.properties` is machine-local and should not be committed. The publishable key is intended for client apps. **Never** put `SUPABASE_SERVICE_ROLE_KEY`, an `sb_secret_...` key, or `AUTH_HMAC_SECRET` in Android, the web client, or any `VITE_` variable.

The Android authentication manager now calls:
`https://ydjynediqdmnosddwusw.supabase.co/functions/v1/{function-name}`

This updates the Android auth endpoint/configuration only. It does not migrate Firebase data or verify the full Android sign-in flow on a device.
