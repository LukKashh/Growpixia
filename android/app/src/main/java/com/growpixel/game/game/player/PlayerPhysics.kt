package com.growpixel.game.game.player

import com.growpixel.game.game.world.WorldTile
import kotlin.math.floor
import kotlin.math.min

object PlayerPhysics {
    const val GRAVITY = 28f
    const val JUMP_VELOCITY = -11.5f
    const val MOVE_SPEED = 7.0f
    const val FRICTION = 0.85f

    fun update(
        player: Player,
        dt: Float,
        tiles: Array<Array<WorldTile>>,
        worldWidth: Int,
        worldHeight: Int
    ) {
        val clampedDt = min(dt, 0.05f)

        // 1. Apply gravity
        player.vy += GRAVITY * clampedDt
        if (player.vy > 20f) player.vy = 20f

        // 2. Horizontal movement & collision
        val newX = player.x + player.vx * clampedDt
        if (isColliding(newX, player.y, player.width, player.height, tiles, worldWidth, worldHeight)) {
            // Hit horizontal wall
            player.vx = 0f
        } else {
            player.x = newX.coerceIn(0f, (worldWidth - player.width))
        }

        // 3. Vertical movement & collision
        val newY = player.y + player.vy * clampedDt
        if (player.vy > 0) { // Falling downward
            if (isColliding(player.x, newY, player.width, player.height, tiles, worldWidth, worldHeight)) {
                // Landed on ground
                player.y = floor(newY + player.height) - player.height
                player.vy = 0f
                player.isGrounded = true
            } else {
                player.y = newY
                player.isGrounded = false
            }
        } else if (player.vy < 0) { // Jumping upward
            if (isColliding(player.x, newY, player.width, player.height, tiles, worldWidth, worldHeight)) {
                // Head bonk
                player.y = floor(newY) + 1f
                player.vy = 0f
            } else {
                player.y = newY
                player.isGrounded = false
            }
        }

        // 4. Update punch animation timer
        if (player.punchState.isPunching && player.punchState.animTimer > 0f) {
            player.punchState.animTimer -= clampedDt
            if (player.punchState.animTimer <= 0f && player.punchState.targetTileX == null) {
                player.punchState.isPunching = false
            }
        }
    }

    private fun isColliding(
        px: Float,
        py: Float,
        pw: Float,
        ph: Float,
        tiles: Array<Array<WorldTile>>,
        worldWidth: Int,
        worldHeight: Int
    ): Boolean {
        val startX = floor(px).toInt().coerceIn(0, worldWidth - 1)
        val endX = floor(px + pw).toInt().coerceIn(0, worldWidth - 1)
        val startY = floor(py).toInt().coerceIn(0, worldHeight - 1)
        val endY = floor(py + ph).toInt().coerceIn(0, worldHeight - 1)

        for (x in startX..endX) {
            for (y in startY..endY) {
                val tile = tiles[x][y]
                if (tile.isSolid) {
                    return true
                }
            }
        }
        return false
    }

    fun jump(player: Player) {
        if (player.isGrounded) {
            player.vy = JUMP_VELOCITY
            player.isGrounded = false
        }
    }

    fun setHorizontalInput(player: Player, axisX: Float) {
        player.vx = axisX * MOVE_SPEED
        if (axisX < -0.1f) {
            player.facing = Facing.LEFT
        } else if (axisX > 0.1f) {
            player.facing = Facing.RIGHT
        }
    }
}
