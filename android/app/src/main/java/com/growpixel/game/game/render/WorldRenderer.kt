package com.growpixel.game.game.render

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import com.growpixel.game.game.items.DroppedStack
import com.growpixel.game.game.items.ItemDatabase
import com.growpixel.game.game.items.ItemIds
import com.growpixel.game.game.objects.SeedPot
import com.growpixel.game.game.player.Facing
import com.growpixel.game.game.player.Player
import com.growpixel.game.game.world.WorldTile
import kotlin.math.cos
import kotlin.math.sin

object WorldRenderer {

    fun renderWorld(
        drawScope: DrawScope,
        camera: Camera2D,
        tiles: Array<Array<WorldTile>>,
        width: Int,
        height: Int,
        seedPots: List<SeedPot>,
        droppedStacks: List<DroppedStack>,
        player: Player
    ) {
        val tileSize = camera.tileSizePx

        // 1. Sky background
        drawScope.drawRect(
            color = GamePalettes.SKY_TOP,
            topLeft = Offset(0f, 0f),
            size = Size(camera.viewportWidthPx, camera.viewportHeightPx)
        )

        // 2. Visible Tile Range calculation to optimize rendering
        val minX = ((camera.x / tileSize).toInt() - 1).coerceIn(0, width - 1)
        val maxX = (((camera.x + camera.viewportWidthPx) / tileSize).toInt() + 1).coerceIn(0, width - 1)
        val minY = ((camera.y / tileSize).toInt() - 1).coerceIn(0, height - 1)
        val maxY = (((camera.y + camera.viewportHeightPx) / tileSize).toInt() + 1).coerceIn(0, height - 1)

        // 3. Render terrain tiles
        for (x in minX..maxX) {
            for (y in minY..maxY) {
                val tile = tiles[x][y]
                val blockId = tile.blockId ?: continue
                val screenPos = camera.worldToScreen(x.toFloat(), y.toFloat())

                drawBlock(drawScope, screenPos, tileSize, blockId, tile.isGrassCapped)
            }
        }

        // 4. Render Seed Pots & Growing Trees
        for (pot in seedPots) {
            if (pot.tileX in minX..maxX && pot.tileY in minY..maxY) {
                val screenPos = camera.worldToScreen(pot.tileX.toFloat(), pot.tileY.toFloat())
                drawSeedPotAndTree(drawScope, screenPos, tileSize, pot)
            }
        }

        // 5. Render Physical Item Pickups (floating/bouncing)
        for (drop in droppedStacks) {
            val screenPos = camera.worldToScreen(drop.x, drop.y)
            drawDroppedStack(drawScope, screenPos, tileSize, drop)
        }

        // 6. Render Mining target cracks & hit progress
        val punch = player.punchState
        if (punch.isPunching && punch.targetTileX != null && punch.targetTileY != null) {
            val targetScreen = camera.worldToScreen(punch.targetTileX!!.toFloat(), punch.targetTileY!!.toFloat())
            drawMiningProgress(drawScope, targetScreen, tileSize, punch.progress)
        }

        // 7. Render Player & Directional Punch Fist
        drawPlayer(drawScope, camera, player)
    }

    private fun drawBlock(
        drawScope: DrawScope,
        pos: Offset,
        size: Float,
        blockId: String,
        isGrassCapped: Boolean
    ) {
        val baseColor = when (blockId) {
            ItemIds.DIRT -> GamePalettes.DIRT_BASE
            ItemIds.STONE -> GamePalettes.STONE_BASE
            ItemIds.WOOD -> GamePalettes.WOOD_BASE
            ItemIds.LEAVES -> GamePalettes.LEAVES_BASE
            ItemIds.SAND -> GamePalettes.SAND_BASE
            ItemIds.LAVA -> GamePalettes.LAVA_BASE
            ItemIds.BEDROCK -> GamePalettes.BEDROCK_BASE
            else -> Color.DarkGray
        }

        // Fill base block
        drawScope.drawRect(
            color = baseColor,
            topLeft = pos,
            size = Size(size, size)
        )

        // Material-specific pixel details
        when (blockId) {
            ItemIds.DIRT -> {
                // Soil speckles
                drawScope.drawRect(GamePalettes.DIRT_DARK, Offset(pos.x + size * 0.2f, pos.y + size * 0.3f), Size(size * 0.15f, size * 0.15f))
                drawScope.drawRect(GamePalettes.DIRT_LIGHT, Offset(pos.x + size * 0.6f, pos.y + size * 0.6f), Size(size * 0.2f, size * 0.15f))
                
                // Surface Grass overlay (ONLY on top surface dirt, grass is NOT an inventory item)
                if (isGrassCapped) {
                    val grassHeight = size * 0.25f
                    drawScope.drawRect(GamePalettes.GRASS_TOP, pos, Size(size, grassHeight))
                    // Grass tufts hanging down
                    drawScope.drawRect(GamePalettes.GRASS_HIGHLIGHT, Offset(pos.x, pos.y), Size(size, size * 0.08f))
                    drawScope.drawRect(GamePalettes.GRASS_SHADOW, Offset(pos.x + size * 0.15f, pos.y + grassHeight), Size(size * 0.15f, size * 0.1f))
                    drawScope.drawRect(GamePalettes.GRASS_TOP, Offset(pos.x + size * 0.55f, pos.y + grassHeight), Size(size * 0.2f, size * 0.12f))
                }
            }
            ItemIds.STONE -> {
                drawScope.drawRect(GamePalettes.STONE_DARK, Offset(pos.x + size * 0.1f, pos.y + size * 0.2f), Size(size * 0.3f, size * 0.2f))
                drawScope.drawRect(GamePalettes.STONE_LIGHT, Offset(pos.x + size * 0.5f, pos.y + size * 0.5f), Size(size * 0.35f, size * 0.25f))
            }
            ItemIds.WOOD -> {
                // Vertical wood grains
                drawScope.drawRect(GamePalettes.WOOD_DARK, Offset(pos.x + size * 0.2f, pos.y), Size(size * 0.12f, size))
                drawScope.drawRect(GamePalettes.WOOD_LIGHT, Offset(pos.x + size * 0.6f, pos.y), Size(size * 0.12f, size))
            }
            ItemIds.LEAVES -> {
                drawScope.drawRect(GamePalettes.LEAVES_DARK, Offset(pos.x + size * 0.1f, pos.y + size * 0.1f), Size(size * 0.3f, size * 0.3f))
                drawScope.drawRect(GamePalettes.LEAVES_LIGHT, Offset(pos.x + size * 0.55f, pos.y + size * 0.45f), Size(size * 0.35f, size * 0.35f))
            }
            ItemIds.SAND -> {
                drawScope.drawRect(GamePalettes.SAND_DARK, Offset(pos.x + size * 0.25f, pos.y + size * 0.35f), Size(size * 0.12f, size * 0.12f))
                drawScope.drawRect(GamePalettes.SAND_LIGHT, Offset(pos.x + size * 0.7f, pos.y + size * 0.2f), Size(size * 0.15f, size * 0.15f))
            }
            ItemIds.LAVA -> {
                drawScope.drawRect(GamePalettes.LAVA_HOT, Offset(pos.x + size * 0.2f, pos.y + size * 0.3f), Size(size * 0.4f, size * 0.2f))
                drawScope.drawRect(GamePalettes.LAVA_DARK, Offset(pos.x + size * 0.1f, pos.y + size * 0.7f), Size(size * 0.5f, size * 0.2f))
            }
            ItemIds.BEDROCK -> {
                drawScope.drawRect(GamePalettes.BEDROCK_DARK, Offset(pos.x + size * 0.15f, pos.y + size * 0.15f), Size(size * 0.3f, size * 0.3f))
                drawScope.drawRect(GamePalettes.BEDROCK_LIGHT, Offset(pos.x + size * 0.6f, pos.y + size * 0.55f), Size(size * 0.25f, size * 0.25f))
            }
        }
    }

    private fun drawSeedPotAndTree(drawScope: DrawScope, pos: Offset, size: Float, pot: SeedPot) {
        val potW = size * 0.7f
        val potH = size * 0.45f
        val potX = pos.x + (size - potW) / 2f
        val potY = pos.y + (size - potH)

        // Seed Pot body (transparent around body/legs)
        drawScope.drawRect(GamePalettes.SEED_POT_CLAY, Offset(potX, potY), Size(potW, potH * 0.7f))
        // Pot rim & soil
        drawScope.drawRect(GamePalettes.SEED_POT_SOIL, Offset(potX + potW * 0.1f, potY), Size(potW * 0.8f, potH * 0.25f))
        // Grounding legs
        drawScope.drawRect(GamePalettes.SEED_POT_DARK, Offset(potX + potW * 0.1f, potY + potH * 0.7f), Size(potW * 0.2f, potH * 0.3f))
        drawScope.drawRect(GamePalettes.SEED_POT_DARK, Offset(potX + potW * 0.7f, potY + potH * 0.7f), Size(potW * 0.2f, potH * 0.3f))

        // Render Tree if planted
        val stage = pot.getGrowthStage()
        if (stage >= 0 && pot.seedDef != null) {
            val trunkColor = GamePalettes.WOOD_BASE
            val foliageColor = when (pot.seedDef!!.associatedBlockId) {
                ItemIds.DIRT -> GamePalettes.DIRT_BASE
                ItemIds.STONE -> GamePalettes.STONE_BASE
                ItemIds.WOOD -> GamePalettes.WOOD_BASE
                ItemIds.LEAVES -> GamePalettes.LEAVES_BASE
                ItemIds.SAND -> GamePalettes.SAND_BASE
                ItemIds.LAVA -> GamePalettes.LAVA_BASE
                else -> GamePalettes.LEAVES_BASE
            }

            when (stage) {
                0 -> { // Sprout
                    drawScope.drawRect(GamePalettes.GRASS_TOP, Offset(pos.x + size * 0.45f, potY - size * 0.25f), Size(size * 0.1f, size * 0.25f))
                    drawScope.drawRect(GamePalettes.GRASS_HIGHLIGHT, Offset(pos.x + size * 0.4f, potY - size * 0.3f), Size(size * 0.2f, size * 0.1f))
                }
                1 -> { // Growing
                    drawScope.drawRect(trunkColor, Offset(pos.x + size * 0.45f, potY - size * 0.6f), Size(size * 0.1f, size * 0.6f))
                    drawScope.drawCircle(foliageColor, radius = size * 0.3f, center = Offset(pos.x + size * 0.5f, potY - size * 0.7f))
                }
                2 -> { // Mature Tree
                    drawScope.drawRect(trunkColor, Offset(pos.x + size * 0.42f, potY - size * 0.9f), Size(size * 0.16f, size * 0.9f))
                    // Big bushy crown themed after block
                    drawScope.drawCircle(foliageColor, radius = size * 0.5f, center = Offset(pos.x + size * 0.5f, potY - size * 1.1f))
                    // Framed block icon indicator on mature tree
                    drawScope.drawRect(Color.White, Offset(pos.x + size * 0.38f, potY - size * 1.25f), Size(size * 0.24f, size * 0.24f))
                    drawScope.drawRect(foliageColor, Offset(pos.x + size * 0.40f, potY - size * 1.23f), Size(size * 0.20f, size * 0.20f))
                }
            }
        }
    }

    private fun drawDroppedStack(drawScope: DrawScope, pos: Offset, size: Float, drop: DroppedStack) {
        val dropSize = size * 0.45f
        // Float animation
        val floatOffset = sin(drop.ageSeconds * 4.0) * 4f

        if (drop.itemId == ItemIds.GEM) {
            // Cut cyan diamond
            val center = Offset(pos.x + size * 0.25f, (pos.y + size * 0.25f) + floatOffset.toFloat())
            drawScope.drawCircle(GamePalettes.GEM_CYAN, radius = dropSize * 0.6f, center = center)
            drawScope.drawCircle(GamePalettes.GEM_WHITE, radius = dropSize * 0.25f, center = Offset(center.x - 2f, center.y - 2f))
        } else {
            // Mini block pickup
            drawScope.drawRect(
                Color.DarkGray,
                Offset(pos.x + size * 0.2f, (pos.y + size * 0.2f) + floatOffset.toFloat()),
                Size(dropSize, dropSize)
            )
        }
    }

    private fun drawMiningProgress(drawScope: DrawScope, pos: Offset, size: Float, progress: Float) {
        // Red highlight + crack outline
        drawScope.drawRect(
            color = Color(1f, 0.2f, 0.2f, 0.35f * progress),
            topLeft = pos,
            size = Size(size, size)
        )
        drawScope.drawRect(
            color = Color.Yellow,
            topLeft = pos,
            size = Size(size, size),
            style = Stroke(width = 3f * progress)
        )
    }

    private fun drawPlayer(drawScope: DrawScope, camera: Camera2D, player: Player) {
        val screenPos = camera.worldToScreen(player.x, player.y)
        val w = player.width * camera.tileSizePx
        val h = player.height * camera.tileSizePx

        val isFacingLeft = player.facing == Facing.LEFT

        // Head
        val headRadius = w * 0.35f
        val headCenter = Offset(screenPos.x + w * 0.5f, screenPos.y + headRadius)
        drawScope.drawCircle(GamePalettes.PLAYER_SKIN, headRadius, headCenter)

        // Hair
        drawScope.drawRect(GamePalettes.PLAYER_HAIR, Offset(headCenter.x - headRadius, headCenter.y - headRadius), Size(headRadius * 2, headRadius * 0.7f))

        // Eyes (determined expression when punching)
        val eyeX = if (isFacingLeft) headCenter.x - headRadius * 0.4f else headCenter.x + headRadius * 0.2f
        val eyeColor = if (player.punchState.isPunching) Color.Red else Color.Black
        drawScope.drawRect(eyeColor, Offset(eyeX, headCenter.y - 2f), Size(3f, 4f))

        // Shirt / Torso
        val torsoY = headCenter.y + headRadius
        val torsoH = h * 0.4f
        drawScope.drawRect(GamePalettes.PLAYER_SHIRT, Offset(screenPos.x + w * 0.2f, torsoY), Size(w * 0.6f, torsoH))

        // Pants / Legs
        val legsY = torsoY + torsoH
        val legsH = h - (legsY - screenPos.y)
        drawScope.drawRect(GamePalettes.PLAYER_PANTS, Offset(screenPos.x + w * 0.25f, legsY), Size(w * 0.5f, legsH.coerceAtLeast(4f)))

        // Directional Punch Fist
        val punch = player.punchState
        if (punch.isPunching) {
            val armOrigin = Offset(screenPos.x + w * 0.5f, torsoY + torsoH * 0.4f)
            val angle = punch.angleRadians
            val reachDist = (camera.tileSizePx * 0.7f) * (0.5f + (1f - (punch.animTimer / 0.25f).coerceIn(0f, 1f)) * 0.5f)

            val fistX = armOrigin.x + cos(angle) * reachDist
            val fistY = armOrigin.y + sin(angle) * reachDist

            // Arm extension line
            drawScope.drawLine(GamePalettes.PLAYER_SKIN, armOrigin, Offset(fistX, fistY), strokeWidth = 5f)
            // Fist glove
            drawScope.drawCircle(GamePalettes.PLAYER_FIST, radius = 9f, center = Offset(fistX, fistY))
        }
    }
}
