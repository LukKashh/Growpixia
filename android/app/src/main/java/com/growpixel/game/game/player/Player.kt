package com.growpixel.game.game.player

import kotlin.math.atan2
import kotlin.math.sqrt

enum class Facing {
    LEFT,
    RIGHT
}

data class PunchState(
    var isPunching: Boolean = false,
    var targetTileX: Int? = null,
    var targetTileY: Int? = null,
    var angleRadians: Float = 0f,
    var progress: Float = 0f, // 0.0 to 1.0 (mining break progress)
    var animTimer: Float = 0f // Punch arm extension timer
)

data class Player(
    var x: Float = 60f,
    var y: Float = 15f,
    var vx: Float = 0f,
    var vy: Float = 0f,
    var isGrounded: Boolean = false,
    var facing: Facing = Facing.RIGHT,
    val width: Float = 0.75f,
    val height: Float = 1.4f,
    val punchState: PunchState = PunchState()
) {
    val centerX: Float
        get() = x + width / 2f

    val centerY: Float
        get() = y + height / 2f

    fun distanceToTile(tileX: Int, tileY: Int): Float {
        val dx = (tileX + 0.5f) - centerX
        val dy = (tileY + 0.5f) - centerY
        return sqrt(dx * dx + dy * dy)
    }

    fun isWithinReach(tileX: Int, tileY: Int, maxReachTiles: Float = 3.2f): Boolean {
        return distanceToTile(tileX, tileY) <= maxReachTiles
    }

    fun setPunchTarget(targetX: Float, targetY: Float, tileX: Int?, tileY: Int?) {
        val dx = targetX - centerX
        val dy = targetY - centerY
        punchState.angleRadians = atan2(dy, dx)
        punchState.targetTileX = tileX
        punchState.targetTileY = tileY
        punchState.isPunching = true
        punchState.animTimer = 0.25f // Duration of punch thrust

        // Turn character to face punch target
        facing = if (dx < 0) Facing.LEFT else Facing.RIGHT
    }

    fun cancelPunch() {
        punchState.isPunching = false
        punchState.targetTileX = null
        punchState.targetTileY = null
        punchState.progress = 0f
    }
}
