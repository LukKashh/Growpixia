package com.growpixel.game.game.items

/**
 * Stable Item and Block identifiers as specified by GrowPixel specification.
 */
object ItemIds {
    const val FIST = "fist"
    const val DIRT = "dirt"
    const val STONE = "stone"
    const val WOOD = "wood"
    const val LEAVES = "leaves"
    const val SAND = "sand"
    const val LAVA = "lava"
    const val SEED_POT = "seed_pot"
    const val BEDROCK = "bedrock"

    const val DIRT_SEED = "dirt_seed"
    const val STONE_SEED = "stone_seed"
    const val WOOD_SEED = "wood_seed"
    const val LEAVES_SEED = "leaves_seed"
    const val SAND_SEED = "sand_seed"
    const val LAVA_SEED = "lava_seed"

    const val GEM = "gem"
}

enum class ItemCategory {
    TOOL,
    BLOCK,
    SEED,
    SPECIAL,
    CURRENCY
}

data class BlockDefinition(
    val id: String,
    val displayName: String,
    val isSolid: Boolean,
    val isBreakable: Boolean,
    val blockDropChance: Float,
    val seedDropChance: Float,
    val associatedSeedId: String?,
    val hardness: Float = 1.0f // Mining duration factor
)

data class SeedDefinition(
    val id: String,
    val displayName: String,
    val associatedBlockId: String,
    val growthDurationSeconds: Int = 30,
    val minYield: Int,
    val maxYield: Int
)

data class ItemDefinition(
    val id: String,
    val displayName: String,
    val category: ItemCategory,
    val isPlaceable: Boolean = false,
    val description: String = ""
)

object ItemDatabase {
    val BLOCKS: Map<String, BlockDefinition> = mapOf(
        ItemIds.DIRT to BlockDefinition(
            id = ItemIds.DIRT,
            displayName = "Dirt",
            isSolid = true,
            isBreakable = true,
            blockDropChance = 0.30f,      // 30%
            seedDropChance = 0.20f,       // 20%
            associatedSeedId = ItemIds.DIRT_SEED,
            hardness = 1.0f
        ),
        ItemIds.STONE to BlockDefinition(
            id = ItemIds.STONE,
            displayName = "Stone",
            isSolid = true,
            isBreakable = true,
            blockDropChance = 0.20f,      // 20%
            seedDropChance = 0.125f,      // 12.5%
            associatedSeedId = ItemIds.STONE_SEED,
            hardness = 1.5f
        ),
        ItemIds.WOOD to BlockDefinition(
            id = ItemIds.WOOD,
            displayName = "Wood",
            isSolid = false,              // Wood is walk-through / background-style
            isBreakable = true,
            blockDropChance = 0.20f,      // 20%
            seedDropChance = 0.15f,       // 15%
            associatedSeedId = ItemIds.WOOD_SEED,
            hardness = 1.2f
        ),
        ItemIds.LEAVES to BlockDefinition(
            id = ItemIds.LEAVES,
            displayName = "Leaves",
            isSolid = true,               // Leaves are solid
            isBreakable = true,
            blockDropChance = 0.15f,      // 15%
            seedDropChance = 0.10f,       // 10%
            associatedSeedId = ItemIds.LEAVES_SEED,
            hardness = 0.6f
        ),
        ItemIds.SAND to BlockDefinition(
            id = ItemIds.SAND,
            displayName = "Sand",
            isSolid = true,
            isBreakable = true,
            blockDropChance = 0.20f,      // 20%
            seedDropChance = 0.10f,       // 10%
            associatedSeedId = ItemIds.SAND_SEED,
            hardness = 0.8f
        ),
        ItemIds.LAVA to BlockDefinition(
            id = ItemIds.LAVA,
            displayName = "Lava",
            isSolid = true,               // Treated as normal solid block for collision
            isBreakable = true,
            blockDropChance = 0.20f,      // 20%
            seedDropChance = 0.225f,      // 22.5%
            associatedSeedId = ItemIds.LAVA_SEED,
            hardness = 1.8f
        ),
        ItemIds.SEED_POT to BlockDefinition(
            id = ItemIds.SEED_POT,
            displayName = "Seed Pot",
            isSolid = false,              // Walk-through
            isBreakable = true,
            blockDropChance = 1.00f,      // 100% guaranteed return of 1 Seed Pot
            seedDropChance = 0.0f,
            associatedSeedId = null,
            hardness = 0.5f
        ),
        ItemIds.BEDROCK to BlockDefinition(
            id = ItemIds.BEDROCK,
            displayName = "Bedrock",
            isSolid = true,
            isBreakable = false,          // Indestructible
            blockDropChance = 0.0f,
            seedDropChance = 0.0f,
            associatedSeedId = null,
            hardness = Float.POSITIVE_INFINITY
        )
    )

    val SEEDS: Map<String, SeedDefinition> = mapOf(
        ItemIds.DIRT_SEED to SeedDefinition(
            id = ItemIds.DIRT_SEED,
            displayName = "Dirt Seed",
            associatedBlockId = ItemIds.DIRT,
            growthDurationSeconds = 30,
            minYield = 2,
            maxYield = 6
        ),
        ItemIds.STONE_SEED to SeedDefinition(
            id = ItemIds.STONE_SEED,
            displayName = "Stone Seed",
            associatedBlockId = ItemIds.STONE,
            growthDurationSeconds = 30,
            minYield = 1,
            maxYield = 3
        ),
        ItemIds.WOOD_SEED to SeedDefinition(
            id = ItemIds.WOOD_SEED,
            displayName = "Wood Seed",
            associatedBlockId = ItemIds.WOOD,
            growthDurationSeconds = 30,
            minYield = 1,
            maxYield = 3
        ),
        ItemIds.LEAVES_SEED to SeedDefinition(
            id = ItemIds.LEAVES_SEED,
            displayName = "Leaves Seed",
            associatedBlockId = ItemIds.LEAVES,
            growthDurationSeconds = 30,
            minYield = 2,
            maxYield = 7
        ),
        ItemIds.SAND_SEED to SeedDefinition(
            id = ItemIds.SAND_SEED,
            displayName = "Sand Seed",
            associatedBlockId = ItemIds.SAND,
            growthDurationSeconds = 30,
            minYield = 2,
            maxYield = 5
        ),
        ItemIds.LAVA_SEED to SeedDefinition(
            id = ItemIds.LAVA_SEED,
            displayName = "Lava Seed",
            associatedBlockId = ItemIds.LAVA,
            growthDurationSeconds = 30,
            minYield = 1,
            maxYield = 5
        )
    )

    val ITEMS: Map<String, ItemDefinition> = mapOf(
        ItemIds.FIST to ItemDefinition(ItemIds.FIST, "Fist", ItemCategory.TOOL, false, "Default mining tool"),
        ItemIds.DIRT to ItemDefinition(ItemIds.DIRT, "Dirt", ItemCategory.BLOCK, true, "Earthy soil block"),
        ItemIds.STONE to ItemDefinition(ItemIds.STONE, "Stone", ItemCategory.BLOCK, true, "Solid subterranean stone"),
        ItemIds.WOOD to ItemDefinition(ItemIds.WOOD, "Wood", ItemCategory.BLOCK, true, "Background walk-through wood"),
        ItemIds.LEAVES to ItemDefinition(ItemIds.LEAVES, "Leaves", ItemCategory.BLOCK, true, "Dense leafy foliage"),
        ItemIds.SAND to ItemDefinition(ItemIds.SAND, "Sand", ItemCategory.BLOCK, true, "Fine granular sand block"),
        ItemIds.LAVA to ItemDefinition(ItemIds.LAVA, "Lava", ItemCategory.BLOCK, true, "Molten volcanic block"),
        ItemIds.SEED_POT to ItemDefinition(ItemIds.SEED_POT, "Seed Pot", ItemCategory.SPECIAL, true, "Walk-through pot for planting seeds"),
        ItemIds.BEDROCK to ItemDefinition(ItemIds.BEDROCK, "Bedrock", ItemCategory.BLOCK, false, "Unbreakable boundary block"),
        
        ItemIds.DIRT_SEED to ItemDefinition(ItemIds.DIRT_SEED, "Dirt Seed", ItemCategory.SEED, false, "Grows into a Dirt Tree in 30s"),
        ItemIds.STONE_SEED to SeedItem(ItemIds.STONE_SEED, "Stone Seed", ItemCategory.SEED),
        ItemIds.WOOD_SEED to SeedItem(ItemIds.WOOD_SEED, "Wood Seed", ItemCategory.SEED),
        ItemIds.LEAVES_SEED to SeedItem(ItemIds.LEAVES_SEED, "Leaves Seed", ItemCategory.SEED),
        ItemIds.SAND_SEED to SeedItem(ItemIds.SAND_SEED, "Sand Seed", ItemCategory.SEED),
        ItemIds.LAVA_SEED to SeedItem(ItemIds.LAVA_SEED, "Lava Seed", ItemCategory.SEED),
        ItemIds.GEM to ItemDefinition(ItemIds.GEM, "Gem", ItemCategory.CURRENCY, false, "Rare crystalline mineral")
    )

    private fun SeedItem(id: String, name: String, cat: ItemCategory): ItemDefinition {
        return ItemDefinition(id, name, cat, false, "Grows a block tree in 30s")
    }

    fun isPlaceableBlock(itemId: String): Boolean {
        return BLOCKS.containsKey(itemId) && itemId != ItemIds.BEDROCK
    }
}
