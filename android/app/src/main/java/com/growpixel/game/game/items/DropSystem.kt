package com.growpixel.game.game.items

import kotlin.random.Random

data class DroppedStack(
    val id: String,
    val itemId: String,
    var count: Int,
    var x: Float,
    var y: Float,
    var vy: Float = -2.5f,
    var vx: Float = (Random.nextFloat() - 0.5f) * 1.5f,
    var ageSeconds: Float = 0f
)

object GemSystem {
    /**
     * Rolls gem quantity for a broken block: 0, 1, 2, or 3 inclusive.
     * Bedrock returns 0. Tree harvesting returns 0.
     */
    fun rollGemsForBrokenBlock(blockId: String): Int {
        if (blockId == ItemIds.BEDROCK) return 0
        return Random.nextInt(0, 4) // 0, 1, 2, 3 inclusive
    }
}

object DropSystem {
    /**
     * Calculates drops when a block is mined.
     * Rolls block drop and seed drop INDEPENDENTLY.
     */
    fun calculateDropsForBlock(blockId: String): List<Pair<String, Int>> {
        val def = ItemDatabase.BLOCKS[blockId] ?: return emptyList()
        if (!def.isBreakable) return emptyList()

        val results = mutableListOf<Pair<String, Int>>()

        // Independent Block Drop Roll
        if (def.blockDropChance > 0f) {
            val roll = Random.nextFloat()
            if (roll < def.blockDropChance) {
                results.add(Pair(def.id, 1))
            }
        }

        // Independent Seed Drop Roll
        if (def.seedDropChance > 0f && def.associatedSeedId != null) {
            val roll = Random.nextFloat()
            if (roll < def.seedDropChance) {
                results.add(Pair(def.associatedSeedId, 1))
            }
        }

        // Independent Gem Drop Roll (0..3)
        val gems = GemSystem.rollGemsForBrokenBlock(blockId)
        if (gems > 0) {
            results.add(Pair(ItemIds.GEM, gems))
        }

        return results
    }

    /**
     * Runs debug simulation of drop rates over N trials to verify exact probabilities.
     */
    fun runDebugSimulation(blockId: String, trials: Int = 100_000): String {
        var blockCount = 0
        var seedCount = 0
        var totalGems = 0

        for (i in 0 until trials) {
            val drops = calculateDropsForBlock(blockId)
            for ((item, qty) in drops) {
                if (item == blockId) blockCount += qty
                else if (item.endsWith("_seed")) seedCount += qty
                else if (item == ItemIds.GEM) totalGems += qty
            }
        }

        val blockRate = (blockCount.toDouble() / trials) * 100
        val seedRate = (seedCount.toDouble() / trials) * 100
        val avgGems = totalGems.toDouble() / trials
        return "Block: %.2f%%, Seed: %.2f%%, Avg Gems/block: %.2f".format(blockRate, seedRate, avgGems)
    }
}
