package com.growpixel.game.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.growpixel.game.game.items.*
import com.growpixel.game.game.objects.SeedPot
import com.growpixel.game.game.player.Player
import com.growpixel.game.game.player.PlayerPhysics
import com.growpixel.game.game.render.Camera2D
import com.growpixel.game.game.render.WorldRenderer
import com.growpixel.game.game.world.WorldGenerator
import com.growpixel.game.game.world.WorldSeed
import com.growpixel.game.game.world.WorldTile
import com.growpixel.game.auth.AuthUser
import kotlinx.coroutines.isActive
import kotlin.math.floor
import kotlin.math.sqrt

@Composable
fun GameRoot(
    currentUser: AuthUser? = null,
    onLogout: () -> Unit = {}
) {
    // 1. World & Game State
    val worldSeed = remember { WorldSeed("GrowPixelMainWorld") }
    val generator = remember { WorldGenerator(width = 100, height = 50, seed = worldSeed) }

    val (initialTiles, spawn) = remember { generator.generate() }
    val tiles = remember { mutableStateOf(initialTiles) }

    val player = remember {
        mutableStateOf(Player(x = spawn.first, y = spawn.second))
    }

    // Starting 10 Seed Pots in inventory granted once on new world
    val inventory = remember {
        val initialMap = mutableStateMapOf<String, Int>(
            ItemIds.SEED_POT to 10,
            ItemIds.DIRT to 15,
            ItemIds.DIRT_SEED to 3
        )
        currentUser?.inventory?.forEach { (k, v) ->
            if (v > 0) initialMap[k] = v
        }
        initialMap
    }

    var gemBalance by remember { mutableIntStateOf(currentUser?.gems ?: 0) }
    var selectedItemId by remember { mutableStateOf(ItemIds.FIST) }

    val seedPots = remember { mutableStateListOf<SeedPot>() }
    val droppedStacks = remember { mutableStateListOf<DroppedStack>() }

    // UI overlays state
    var showGemStore by remember { mutableStateOf(false) }
    var showInventory by remember { mutableStateOf(false) }
    var showMenu by remember { mutableStateOf(false) }

    // Nearby seed pot context
    var nearbyPot by remember { mutableStateOf<SeedPot?>(null) }

    val camera = remember { Camera2D() }

    // Frame update loop
    var lastFrameNano by remember { mutableLongStateOf(0L) }
    var renderTick by remember { mutableLongStateOf(0L) }

    LaunchedEffect(Unit) {
        while (isActive) {
            withFrameNanos { frameTimeNano ->
                if (lastFrameNano != 0L) {
                    val dt = ((frameTimeNano - lastFrameNano) / 1_000_000_000f).coerceIn(0.001f, 0.05f)

                    val p = player.value
                    // Physics integration
                    PlayerPhysics.update(p, dt, tiles.value, generator.width, generator.height)

                    // Drops physics & player collection
                    val iter = droppedStacks.iterator()
                    while (iter.hasNext()) {
                        val drop = iter.next()
                        drop.ageSeconds += dt
                        drop.y += drop.vy * dt
                        drop.vy += 12f * dt
                        if (drop.vy > 0 && drop.y > p.y + 0.5f) {
                            drop.vy = 0f
                        }

                        // Collect on touch
                        val dist = sqrt((drop.x - p.centerX) * (drop.x - p.centerX) + (drop.y - p.centerY) * (drop.y - p.centerY))
                        if (dist < 1.0f) {
                            if (drop.itemId == ItemIds.GEM) {
                                gemBalance += drop.count
                            } else {
                                val current = inventory[drop.itemId] ?: 0
                                inventory[drop.itemId] = current + drop.count
                            }
                            iter.remove()
                        }
                    }

                    // Check nearest seed pot
                    var closest: SeedPot? = null
                    var minDist = Float.MAX_VALUE
                    for (pot in seedPots) {
                        val d = p.distanceToTile(pot.tileX, pot.tileY)
                        if (d <= 2.5f && d < minDist) {
                            minDist = d
                            closest = pot
                        }
                    }
                    nearbyPot = closest

                    // Camera follow
                    camera.followPlayer(p.centerX, p.centerY, p.facing == com.growpixel.game.game.player.Facing.LEFT)
                    renderTick++
                }
                lastFrameNano = frameTimeNano
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black)
            .onSizeChanged { size ->
                camera.viewportWidthPx = size.width.toFloat()
                camera.viewportHeightPx = size.height.toFloat()
            }
    ) {
        // WORLD CANVAS
        Canvas(
            modifier = Modifier
                .fillMaxSize()
                .pointerInput(selectedItemId) {
                    detectTapGestures(
                        onPress = { offset ->
                            val (wx, wy) = camera.screenToWorld(offset.x, offset.y)
                            val targetTx = floor(wx).toInt()
                            val targetTy = floor(wy).toInt()

                            val p = player.value

                            // Punch target or empty air
                            p.setPunchTarget(wx, wy, targetTx, targetTy)

                            if (p.isWithinReach(targetTx, targetTy)) {
                                if (targetTx in 0 until generator.width && targetTy in 0 until generator.height) {
                                    val tile = tiles.value[targetTx][targetTy]

                                    // Harvest mature tree tap
                                    val pot = seedPots.find { it.tileX == targetTx && it.tileY == targetTy }
                                    if (pot != null && pot.isMature()) {
                                        val harvestResult = pot.harvest()
                                        if (harvestResult != null) {
                                            val (blockId, count) = harvestResult
                                            droppedStacks.add(DroppedStack("drop_${System.currentTimeMillis()}", blockId, count, targetTx + 0.5f, targetTy + 0.5f))
                                        }
                                        return@detectTapGestures
                                    }

                                    // Plant seed tap
                                    if (pot != null && pot.isEmpty && selectedItemId.endsWith("_seed")) {
                                        val count = inventory[selectedItemId] ?: 0
                                        if (count > 0) {
                                            inventory[selectedItemId] = count - 1
                                            pot.plantedSeedId = selectedItemId
                                            pot.plantedTimestampMillis = System.currentTimeMillis()
                                        }
                                        return@detectTapGestures
                                    }

                                    // Place block tap
                                    if (tile.blockId == null && ItemDatabase.isPlaceableBlock(selectedItemId)) {
                                        val count = inventory[selectedItemId] ?: 0
                                        if (count > 0) {
                                            if (selectedItemId == ItemIds.SEED_POT) {
                                                seedPots.add(SeedPot(targetTx, targetTy))
                                                inventory[selectedItemId] = count - 1
                                            } else {
                                                tile.blockId = selectedItemId
                                                WorldGenerator.updateGrassCaps(tiles.value, generator.width, generator.height)
                                                inventory[selectedItemId] = count - 1
                                            }
                                        }
                                        return@detectTapGestures
                                    }

                                    // Mining block: Bedrock is indestructible
                                    if (tile.blockId != null && tile.blockId != ItemIds.BEDROCK) {
                                        val blockId = tile.blockId!!
                                        val drops = DropSystem.calculateDropsForBlock(blockId)
                                        for ((dropId, dropQty) in drops) {
                                            droppedStacks.add(
                                                DroppedStack("drop_${System.currentTimeMillis()}_$dropId", dropId, dropQty, targetTx + 0.5f, targetTy + 0.5f)
                                            )
                                        }
                                        tile.blockId = null
                                        WorldGenerator.updateGrassCaps(tiles.value, generator.width, generator.height)
                                    }
                                }
                            }

                            tryAwaitRelease()
                            p.cancelPunch()
                        }
                    )
                }
        ) {
            // Re-draw on renderTick
            if (renderTick >= 0) {
                WorldRenderer.renderWorld(
                    drawScope = this,
                    camera = camera,
                    tiles = tiles.value,
                    width = generator.width,
                    height = generator.height,
                    seedPots = seedPots,
                    droppedStacks = droppedStacks,
                    player = player.value
                )
            }
        }

        // TOP-LEFT: GEM STORE BANNER BUTTON
        Box(
            modifier = Modifier
                .padding(start = 16.dp, top = 16.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(Color(0xEE1A1C24))
                .border(2.dp, Color(0xFF00E5FF), RoundedCornerShape(8.dp))
                .clickable { showGemStore = true }
                .padding(horizontal = 14.dp, vertical = 8.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text("💎", fontSize = 14.sp)
                Text(
                    text = "GEM STORE",
                    color = Color(0xFF00E5FF),
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp
                )
                Text(
                    text = "$gemBalance",
                    color = Color(0xFFE0FFFF),
                    fontWeight = FontWeight.SemiBold,
                    fontSize = 12.sp
                )
            }
        }

        // TOP-RIGHT: MENU BUTTON (NO world pill, NO bag button)
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(end = 16.dp, top = 16.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(Color(0xCC1E1E24))
                .border(1.5.dp, Color(0xFF555555), RoundedCornerShape(8.dp))
                .clickable { showMenu = true }
                .padding(horizontal = 14.dp, vertical = 8.dp)
        ) {
            Text("MENU", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 12.sp)
        }

        // CONTEXTUAL SEED POT PANEL
        nearbyPot?.let { pot ->
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = 16.dp)
            ) {
                SeedPotInfoPanel(
                    pot = pot,
                    onHarvest = {
                        val result = pot.harvest()
                        if (result != null) {
                            val (blockId, count) = result
                            droppedStacks.add(DroppedStack("drop_${System.currentTimeMillis()}", blockId, count, pot.tileX + 0.5f, pot.tileY + 0.5f))
                        }
                    }
                )
            }
        }

        // LOWER-LEFT: HORIZONTAL JOYSTICK
        JoystickControl(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(start = 28.dp, bottom = 24.dp),
            onMove = { axisX ->
                PlayerPhysics.setHorizontalInput(player.value, axisX)
            }
        )

        // LOWER-RIGHT: JUMP BUTTON
        JumpButton(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(end = 28.dp, bottom = 28.dp),
            onJump = {
                PlayerPhysics.jump(player.value)
            }
        )

        // BOTTOM-CENTRE: HOTBAR (Slot 4 is dedicated Inventory)
        Hotbar(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 16.dp),
            selectedItemId = selectedItemId,
            inventoryQuantities = inventory,
            onSelectSlot = { itemId -> selectedItemId = itemId },
            onOpenInventory = { showInventory = true }
        )

        // OVERLAY MODALS
        if (showGemStore) {
            GemStorePanel(
                gemBalance = gemBalance,
                onClose = { showGemStore = false }
            )
        }

        if (showInventory) {
            InventoryPanel(
                inventory = inventory,
                onSelectItem = { selectedItemId = it },
                onClose = { showInventory = false }
            )
        }

        if (showMenu) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xAA000000))
                    .clickable { showMenu = false },
                contentAlignment = Alignment.Center
            ) {
                Column(
                    modifier = Modifier
                        .width(320.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .background(Color(0xFF1E1E24))
                        .border(2.dp, Color(0xFF81C784), RoundedCornerShape(12.dp))
                        .padding(20.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Text("GROWPIXEL MENU", color = Color(0xFF81C784), fontWeight = FontWeight.Bold, fontSize = 16.sp)
                    Text("Player: ${currentUser?.username ?: "Guest"}", color = Color(0xFF38BDF8), fontWeight = FontWeight.SemiBold, fontSize = 13.sp)
                    Text("World: ${worldSeed.worldName}", color = Color.LightGray, fontSize = 12.sp)
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(6.dp))
                            .background(Color(0xFF2C3E50))
                            .clickable { showMenu = false }
                            .padding(10.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text("RESUME", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 12.sp)
                    }
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(6.dp))
                            .background(Color(0xFF7F1D1D))
                            .clickable {
                                showMenu = false
                                onLogout()
                            }
                            .padding(10.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text("LOGOUT", color = Color(0xFFFECACA), fontWeight = FontWeight.Bold, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}
