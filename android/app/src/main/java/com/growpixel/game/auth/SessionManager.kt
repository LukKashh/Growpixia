package com.growpixel.game.auth

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

data class AuthUser(
    val id: String,
    val username: String,
    val gems: Int,
    val inventory: Map<String, Int> = emptyMap()
)

data class AuthSession(
    val accessToken: String,
    val refreshToken: String,
    val expiresIn: Int = 3600,
    val tokenType: String = "bearer",
    val email: String? = null
)

class SessionManager(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    companion object {
        private const val PREFS_NAME = "growpixel_auth_session"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_USERNAME = "username"
        private const val KEY_GEMS = "gems"
        private const val KEY_INVENTORY_JSON = "inventory_json"

        @Volatile
        private var instance: SessionManager? = null

        fun getInstance(context: Context): SessionManager {
            return instance ?: synchronized(this) {
                instance ?: SessionManager(context.applicationContext).also { instance = it }
            }
        }
    }

    fun saveSession(user: AuthUser, session: AuthSession) {
        val invObj = JSONObject()
        user.inventory.forEach { (k, v) -> invObj.put(k, v) }

        prefs.edit()
            .putString(KEY_ACCESS_TOKEN, session.accessToken)
            .putString(KEY_REFRESH_TOKEN, session.refreshToken)
            .putString(KEY_USER_ID, user.id)
            .putString(KEY_USERNAME, user.username)
            .putInt(KEY_GEMS, user.gems)
            .putString(KEY_INVENTORY_JSON, invObj.toString())
            .apply()
    }

    fun updateGems(gems: Int) {
        prefs.edit().putInt(KEY_GEMS, gems).apply()
    }

    fun getUser(): AuthUser? {
        val id = prefs.getString(KEY_USER_ID, null) ?: return null
        val username = prefs.getString(KEY_USERNAME, "") ?: return null
        val gems = prefs.getInt(KEY_GEMS, 0)
        val invJson = prefs.getString(KEY_INVENTORY_JSON, "{}") ?: "{}"

        val invMap = mutableMapOf<String, Int>()
        try {
            val json = JSONObject(invJson)
            val keys = json.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                invMap[k] = json.optInt(k, 0)
            }
        } catch (_: Exception) {}

        return AuthUser(id = id, username = username, gems = gems, inventory = invMap)
    }

    fun getAccessToken(): String? = prefs.getString(KEY_ACCESS_TOKEN, null)

    fun getRefreshToken(): String? = prefs.getString(KEY_REFRESH_TOKEN, null)

    fun isLoggedIn(): Boolean {
        return !prefs.getString(KEY_ACCESS_TOKEN, null).isNullOrBlank() &&
                !prefs.getString(KEY_USERNAME, null).isNullOrBlank()
    }

    fun clearSession() {
        prefs.edit().clear().apply()
    }
}
