package com.growpixel.game.game.objects

import com.growpixel.game.game.items.ItemDatabase
import com.growpixel.game.game.items.ItemIds
import kotlin.random.Random

data class SeedPot(
    val tileX: Int,
    val tileY: Int,
    var plantedSeedId: String? = null,
    var plantedTimestampMillis: Long = 0L,
    var isHarvested: Boolean = false
) {
    val isEmpty: Boolean
        get() = plantedSeedId == null

    val seedDef
        get() = plantedSeedId?.let { ItemDatabase.SEEDS[it] }

    fun getRemainingSeconds(nowMillis: Long = System.currentTimeMillis()): Int {
        val def = seedDef ?: return 0
        val elapsedSec = ((nowMillis - plantedTimestampMillis) / 1000L).toInt()
        val remaining = def.growthDurationSeconds - elapsedSec
        return remaining.coerceAtLeast(0)
    }

    fun isMature(nowMillis: Long = System.currentTimeMillis()): Boolean {
        if (isEmpty) return false
        return getRemainingSeconds(nowMillis) == 0
    }

    /**
     * Growth stage:
     * 0 = Sprout (0s - 10s)
     * 1 = Growing Sapling (10s - 29s)
     * 2 = Mature Tree (30s+)
     */
    fun getGrowthStage(nowMillis: Long = System.currentTimeMillis()): Int {
        if (isEmpty) return -1
        val def = seedDef ?: return -1
        val elapsedSec = ((nowMillis - plantedTimestampMillis) / 1000L).toFloat()
        val progress = (elapsedSec / def.growthDurationSeconds).coerceIn(0f, 1f)
        return when {
            progress < 0.33f -> 0
            progress < 1.0f -> 1
            else -> 2
        }
    }

    /**
     * Executes one-tap harvest.
     * Returns the pair of (harvestedBlockId, yieldQuantity).
     * Awards 0 Gems and does not return the seed.
     */
    fun harvest(nowMillis: Long = System.currentTimeMillis()): Pair<String, Int>? {
        if (!isMature(nowMillis)) return null
        val def = seedDef ?: return null

        val yieldCount = Random.nextInt(def.minYield, def.maxYield + 1)
        val harvestedBlock = def.associatedBlockId

        // Reset pot to empty for replanting
        plantedSeedId = null
        plantedTimestampMillis = 0L

        return Pair(harvestedBlock, yieldCount)
    }
}
