package com.growpixel.game.game.render

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import com.growpixel.game.game.items.ItemIds

object GamePalettes {
    val SKY_TOP = Color(0xFF6BB5FF)
    val SKY_BOTTOM = Color(0xFFA6D5FF)

    val DIRT_BASE = Color(0xFF865439)
    val DIRT_DARK = Color(0xFF5F3B27)
    val DIRT_LIGHT = Color(0xFFA06A4B)

    val GRASS_TOP = Color(0xFF5EBA38)
    val GRASS_HIGHLIGHT = Color(0xFF85E65C)
    val GRASS_SHADOW = Color(0xFF418A23)

    val STONE_BASE = Color(0xFF787B82)
    val STONE_DARK = Color(0xFF56585E)
    val STONE_LIGHT = Color(0xFF9EA2AB)

    val WOOD_BASE = Color(0xFF9E6534)
    val WOOD_DARK = Color(0xFF6B411E)
    val WOOD_LIGHT = Color(0xFFBE844E)

    val LEAVES_BASE = Color(0xFF2E8A37)
    val LEAVES_DARK = Color(0xFF1D5C24)
    val LEAVES_LIGHT = Color(0xFF4AC456)

    val SAND_BASE = Color(0xFFE5C170)
    val SAND_DARK = Color(0xFFBA964C)
    val SAND_LIGHT = Color(0xFFF7DE9E)

    val LAVA_BASE = Color(0xFFFF5500)
    val LAVA_HOT = Color(0xFFFFCC00)
    val LAVA_DARK = Color(0xFF991100)

    val BEDROCK_BASE = Color(0xFF26262B)
    val BEDROCK_DARK = Color(0xFF151518)
    val BEDROCK_LIGHT = Color(0xFF42424A)

    val SEED_POT_CLAY = Color(0xFFBF5E3B)
    val SEED_POT_DARK = Color(0xFF80381E)
    val SEED_POT_SOIL = Color(0xFF4A2F1B)

    val GEM_CYAN = Color(0xFF00E5FF)
    val GEM_WHITE = Color(0xFFE0FFFF)
    val GEM_DARK = Color(0xFF00838F)

    val PLAYER_SKIN = Color(0xFFFFCC99)
    val PLAYER_HAIR = Color(0xFF5C3317)
    val PLAYER_SHIRT = Color(0xFF2196F3)
    val PLAYER_PANTS = Color(0xFF1A237E)
    val PLAYER_FIST = Color(0xFFFFA726)
}

class Camera2D(
    var viewportWidthPx: Float = 960f,
    var viewportHeightPx: Float = 540f,
    var tileSizePx: Float = 48f
) {
    var x: Float = 0f
    var y: Float = 0f

    fun followPlayer(playerX: Float, playerY: Float, playerFacingLeft: Boolean, smoothing: Float = 0.12f) {
        // Look-ahead slightly in direction of facing
        val targetLead = if (playerFacingLeft) -1.8f else 1.8f
        val targetX = (playerX + targetLead) * tileSizePx - viewportWidthPx / 2f
        val targetY = playerY * tileSizePx - viewportHeightPx / 2f

        x += (targetX - x) * smoothing
        y += (targetY - y) * smoothing
    }

    fun worldToScreen(worldX: Float, worldY: Float): Offset {
        return Offset(worldX * tileSizePx - x, worldY * tileSizePx - y)
    }

    fun screenToWorld(screenX: Float, screenY: Float): Pair<Float, Float> {
        val wx = (screenX + x) / tileSizePx
        val wy = (screenY + y) / tileSizePx
        return Pair(wx, wy)
    }
}
