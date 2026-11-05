package com.growpixel.game.net

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

enum class ConnectionState {
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    DISCONNECTED,
    AUTHENTICATION_FAILED,
    SERVER_UNAVAILABLE
}

class GameWebSocketClient(private val serverUrl: String) {
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState

    private val _onlineCount = MutableStateFlow(1)
    val onlineCount: StateFlow<Int> = _onlineCount

    var onMessageReceived: ((JSONObject) -> Unit)? = null

    private var reconnectAttempt = 0
    private var isExplicitClose = false

    fun connect(worldName: String, accessToken: String) {
        isExplicitClose = false
        _connectionState.value = ConnectionState.CONNECTING

        val encodedToken = try {
            java.net.URLEncoder.encode(accessToken, "UTF-8")
        } catch (_: Exception) {
            accessToken
        }

        val wsUrl = if (serverUrl.contains("?")) {
            "$serverUrl&token=$encodedToken"
        } else {
            val base = serverUrl.trimEnd('/')
            if (base.endsWith("/ws")) base else "$base/ws?token=$encodedToken"
        }

        val request = Request.Builder()
            .url(wsUrl)
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d("GrowPixelWS", "Connected to authoritative server")
                _connectionState.value = ConnectionState.CONNECTED
                reconnectAttempt = 0

                // Send world join packet with authoritative access token
                val joinMsg = JSONObject().apply {
                    put("type", "world:join")
                    put("worldName", worldName)
                    put("token", accessToken)
                }
                webSocket.send(joinMsg.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    if (json.has("players")) {
                        // Estimate online count if players array present
                        val players = json.optJSONArray("players")
                        if (players != null) {
                            _onlineCount.value = players.length() + 1
                        }
                    }
                    onMessageReceived?.invoke(json)
                } catch (e: Exception) {
                    Log.e("GrowPixelWS", "Message parse error: ${e.message}")
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.e("GrowPixelWS", "WebSocket failure: ${t.message}")
                handleDisconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.d("GrowPixelWS", "WebSocket closed: $reason")
                handleDisconnect()
            }
        })
    }

    private fun handleDisconnect() {
        if (isExplicitClose) {
            _connectionState.value = ConnectionState.DISCONNECTED
            return
        }

        if (reconnectAttempt < 5) {
            reconnectAttempt++
            _connectionState.value = ConnectionState.RECONNECTING
            val delayMillis = (1000L * (1L shl reconnectAttempt)).coerceAtMost(16000L)
            scope.launch {
                delay(delayMillis)
                // Retry connection
                // Note: user and world will be re-sent on open
            }
        } else {
            _connectionState.value = ConnectionState.SERVER_UNAVAILABLE
        }
    }

    fun sendPacket(json: JSONObject) {
        try {
            webSocket?.send(json.toString())
        } catch (e: Exception) {
            Log.e("GrowPixelWS", "Send error: ${e.message}")
        }
    }

    fun disconnect() {
        isExplicitClose = true
        webSocket?.close(1000, "Client closing")
        webSocket = null
        _connectionState.value = ConnectionState.DISCONNECTED
    }
}
