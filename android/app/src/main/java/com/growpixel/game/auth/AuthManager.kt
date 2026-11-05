package com.growpixel.game.auth

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class RegisterResponse(
    val user: AuthUser,
    val session: AuthSession,
    val recoveryCode: String
)

data class LoginResponse(
    val user: AuthUser,
    val session: AuthSession
)

data class RecoverResponse(
    val success: Boolean,
    val message: String
)

class AuthManager(private val context: Context) {
    private val sessionManager = SessionManager.getInstance(context)
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    // Configurable endpoint: Supabase URL or local dev bridge (10.0.2.2 for Android emulator)
    var baseUrl: String = "http://10.0.2.2:3000"
    var publishableKey: String = ""

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val USERNAME_REGEX = Regex("^[a-zA-Z0-9_-]+$")
    }

    private fun getEdgeFunctionUrl(functionName: String): String {
        val cleanBase = baseUrl.trimEnd('/')
        return if (cleanBase.contains("supabase.co")) {
            "$cleanBase/functions/v1/$functionName"
        } else {
            "$cleanBase/functions/v1/$functionName"
        }
    }

    suspend fun registerPlayer(
        username: String,
        password: String,
        confirmPassword: String
    ): Result<RegisterResponse> = withContext(Dispatchers.IO) {
        val clean = username.trim()
        if (clean.length < 3 || clean.length > 16 || !USERNAME_REGEX.matches(clean)) {
            return@withContext Result.failure(
                IllegalArgumentException("Username must be 3-16 alphanumeric characters, hyphens, or underscores.")
            )
        }
        if (password.length < 8) {
            return@withContext Result.failure(
                IllegalArgumentException("Password must be at least 8 characters long.")
            )
        }
        if (password != confirmPassword) {
            return@withContext Result.failure(
                IllegalArgumentException("Passwords do not match.")
            )
        }

        try {
            val payload = JSONObject().apply {
                put("username", clean)
                put("password", password)
                put("confirmPassword", confirmPassword)
            }

            val requestBuilder = Request.Builder()
                .url(getEdgeFunctionUrl("register-player"))
                .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))

            if (publishableKey.isNotBlank()) {
                requestBuilder.addHeader("apikey", publishableKey)
                requestBuilder.addHeader("Authorization", "Bearer $publishableKey")
            }

            val response = client.newCall(requestBuilder.build()).execute()
            val bodyString = response.body?.string() ?: "{}"
            val json = JSONObject(bodyString)

            if (!response.isSuccessful) {
                val errorMsg = json.optString("error", "Registration failed (HTTP ${response.code}).")
                return@withContext Result.failure(Exception(errorMsg))
            }

            val userObj = json.optJSONObject("user") ?: JSONObject()
            val sessionObj = json.optJSONObject("session") ?: JSONObject()
            val recoveryCode = json.optString("recoveryCode", "")

            val authUser = parseAuthUser(userObj, clean)
            val authSession = parseAuthSession(sessionObj)

            sessionManager.saveSession(authUser, authSession)

            Result.success(RegisterResponse(authUser, authSession, recoveryCode))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun loginPlayer(
        username: String,
        password: String
    ): Result<LoginResponse> = withContext(Dispatchers.IO) {
        val clean = username.trim()
        if (clean.isEmpty()) {
            return@withContext Result.failure(IllegalArgumentException("Please enter your username."))
        }
        if (password.isEmpty()) {
            return@withContext Result.failure(IllegalArgumentException("Please enter your password."))
        }

        try {
            val payload = JSONObject().apply {
                put("username", clean)
                put("password", password)
            }

            val requestBuilder = Request.Builder()
                .url(getEdgeFunctionUrl("login-player"))
                .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))

            if (publishableKey.isNotBlank()) {
                requestBuilder.addHeader("apikey", publishableKey)
                requestBuilder.addHeader("Authorization", "Bearer $publishableKey")
            }

            val response = client.newCall(requestBuilder.build()).execute()
            val bodyString = response.body?.string() ?: "{}"
            val json = JSONObject(bodyString)

            if (!response.isSuccessful) {
                val errorMsg = json.optString("error", "Invalid username or password.")
                return@withContext Result.failure(Exception(errorMsg))
            }

            val userObj = json.optJSONObject("user") ?: JSONObject()
            val sessionObj = json.optJSONObject("session") ?: JSONObject()

            val authUser = parseAuthUser(userObj, clean)
            val authSession = parseAuthSession(sessionObj)

            sessionManager.saveSession(authUser, authSession)

            Result.success(LoginResponse(authUser, authSession))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    suspend fun recoverPlayer(
        recoveryCode: String,
        newPassword: String
    ): Result<RecoverResponse> = withContext(Dispatchers.IO) {
        val cleanCode = recoveryCode.trim()
        if (cleanCode.isEmpty()) {
            return@withContext Result.failure(IllegalArgumentException("Please enter your recovery code."))
        }
        if (newPassword.length < 8) {
            return@withContext Result.failure(
                IllegalArgumentException("New password must be at least 8 characters long.")
            )
        }

        try {
            val payload = JSONObject().apply {
                put("recoveryCode", cleanCode)
                put("newPassword", newPassword)
            }

            val requestBuilder = Request.Builder()
                .url(getEdgeFunctionUrl("recover-player"))
                .post(payload.toString().toRequestBody(JSON_MEDIA_TYPE))

            if (publishableKey.isNotBlank()) {
                requestBuilder.addHeader("apikey", publishableKey)
                requestBuilder.addHeader("Authorization", "Bearer $publishableKey")
            }

            val response = client.newCall(requestBuilder.build()).execute()
            val bodyString = response.body?.string() ?: "{}"
            val json = JSONObject(bodyString)

            if (!response.isSuccessful) {
                val errorMsg = json.optString("error", "Recovery failed (HTTP ${response.code}).")
                return@withContext Result.failure(Exception(errorMsg))
            }

            val message = json.optString("message", "Password successfully reset.")
            Result.success(RecoverResponse(true, message))
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun logout() {
        sessionManager.clearSession()
    }

    fun getCurrentUser(): AuthUser? = sessionManager.getUser()

    fun isLoggedIn(): Boolean = sessionManager.isLoggedIn()

    private fun parseAuthUser(userObj: JSONObject, fallbackUsername: String): AuthUser {
        val id = userObj.optString("id", "user_${System.currentTimeMillis()}")
        val username = userObj.optString("username", fallbackUsername)
        val gems = userObj.optInt("gems", 0)
        val invMap = mutableMapOf<String, Int>()
        val invObj = userObj.optJSONObject("inventory")
        if (invObj != null) {
            val keys = invObj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                invMap[k] = invObj.optInt(k, 0)
            }
        }
        return AuthUser(id = id, username = username, gems = gems, inventory = invMap)
    }

    private fun parseAuthSession(sessionObj: JSONObject): AuthSession {
        val accessToken = sessionObj.optString("access_token", "")
        val refreshToken = sessionObj.optString("refresh_token", "")
        val expiresIn = sessionObj.optInt("expires_in", 3600)
        val tokenType = sessionObj.optString("token_type", "bearer")
        val userObj = sessionObj.optJSONObject("user")
        val email = userObj?.optString("email", null)

        return AuthSession(
            accessToken = accessToken,
            refreshToken = refreshToken,
            expiresIn = expiresIn,
            tokenType = tokenType,
            email = email
        )
    }
}
