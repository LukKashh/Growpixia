package com.growpixel.game.game.world

import com.growpixel.game.game.items.ItemDatabase
import com.growpixel.game.game.items.ItemIds
import kotlin.math.sin
import kotlin.random.Random

data class WorldTile(
    var blockId: String?,
    var isGrassCapped: Boolean = false
) {
    val isSolid: Boolean
        get() = blockId?.let { ItemDatabase.BLOCKS[it]?.isSolid } ?: false

    val isBreakable: Boolean
        get() = blockId?.let { ItemDatabase.BLOCKS[it]?.isBreakable } ?: false
}

data class WorldSeed(
    val worldName: String,
    val seedValue: Long = deterministicHash(worldName)
) {
    companion object {
        fun deterministicHash(name: String): Long {
            var h = 1125899906842624L
            val len = name.length
            for (i in 0 until len) {
                h = 31 * h + name[i].code.toLong()
            }
            return h
        }
    }
}

class WorldGenerator(
    val width: Int = 120,
    val height: Int = 60,
    val seed: WorldSeed
) {
    fun generate(): Pair<Array<Array<WorldTile>>, Pair<Float, Float>> {
        val random = Random(seed.seedValue)
        val tiles = Array(width) { Array(height) { WorldTile(null) } }

        val surfaceBaseY = 22 // Average surface level (0 is top sky, height-1 is bottom bedrock)

        // 1. Bedrock bottom boundary
        for (x in 0 until width) {
            tiles[x][height - 1] = WorldTile(ItemIds.BEDROCK)
            // Uneven bedrock floor
            if (random.nextFloat() < 0.4f) {
                tiles[x][height - 2] = WorldTile(ItemIds.BEDROCK)
            }
        }

        // 2. Deep Lava Layer (just above bedrock)
        val lavaStartY = height - 10
        for (x in 0 until width) {
            for (y in lavaStartY until height - 2) {
                if (random.nextFloat() < 0.65f) {
                    tiles[x][y] = WorldTile(ItemIds.LAVA)
                } else {
                    tiles[x][y] = WorldTile(ItemIds.STONE)
                }
            }
        }

        // 3. Terrain Heightfield Generation
        val surfaceHeights = IntArray(width)
        for (x in 0 until width) {
            // Smooth undulating sine hills combined with pseudo-random octaves
            val wave1 = (sin(x * 0.08) * 4).toInt()
            val wave2 = (sin(x * 0.03 + 1.2) * 2).toInt()
            val jitter = random.nextInt(-1, 2)
            val surfaceY = (surfaceBaseY + wave1 + wave2 + jitter).coerceIn(12, 32)
            surfaceHeights[x] = surfaceY

            // Surface dirt with grass cap
            tiles[x][surfaceY] = WorldTile(ItemIds.DIRT, isGrassCapped = true)

            // Sub-surface dirt layer (3-5 tiles deep)
            val dirtDepth = random.nextInt(3, 6)
            for (y in (surfaceY + 1) until (surfaceY + dirtDepth).coerceAtMost(height - 1)) {
                if (tiles[x][y].blockId == null) {
                    tiles[x][y] = WorldTile(ItemIds.DIRT, isGrassCapped = false)
                }
            }

            // Underground Stone from dirt to lava
            for (y in (surfaceY + dirtDepth) until lavaStartY) {
                if (tiles[x][y].blockId == null) {
                    // Occasional Sand deposits or Stone
                    val rand = random.nextFloat()
                    val block = when {
                        rand < 0.12f -> ItemIds.SAND
                        rand < 0.16f -> ItemIds.WOOD // buried roots
                        else -> ItemIds.STONE
                    }
                    tiles[x][y] = WorldTile(block)
                }
            }
        }

        // 4. Update surface grass visibility on any exposed dirt
        updateGrassCaps(tiles, width, height)

        // 5. Find a Safe Spawn point
        val spawnX = (width / 2).toFloat()
        var spawnY = surfaceHeights[width / 2] - 2f // Stand safely on surface

        // Verify spawn is not inside solid terrain
        val sx = spawnX.toInt().coerceIn(0, width - 1)
        for (y in 0 until height - 2) {
            if (tiles[sx][y + 1].isSolid && !tiles[sx][y].isSolid && !tiles[sx][(y - 1).coerceAtLeast(0)].isSolid) {
                spawnY = y.toFloat()
                break
            }
        }

        return Pair(tiles, Pair(spawnX, spawnY))
    }

    companion object {
        fun updateGrassCaps(tiles: Array<Array<WorldTile>>, width: Int, height: Int) {
            for (x in 0 until width) {
                for (y in 0 until height) {
                    val tile = tiles[x][y]
                    if (tile.blockId == ItemIds.DIRT) {
                        // Grass cap only if above tile is empty / non-solid
                        val isExposed = y == 0 || !tiles[x][y - 1].isSolid
                        tile.isGrassCapped = isExposed
                    } else {
                        tile.isGrassCapped = false
                    }
                }
            }
        }
    }
}
