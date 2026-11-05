package com.growpixel.game.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.growpixel.game.game.items.ItemDatabase
import com.growpixel.game.game.items.ItemIds
import com.growpixel.game.game.objects.SeedPot

@Composable
fun GemStorePanel(
    gemBalance: Int,
    onClose: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0x99000000))
            .clickable { onClose() },
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .width(420.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF1E1F29))
                .border(2.dp, Color(0xFF00E5FF), RoundedCornerShape(12.dp))
                .clickable(enabled = false) {}
                .padding(20.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "GEM STORE",
                    color = Color(0xFF00E5FF),
                    fontWeight = FontWeight.Bold,
                    fontSize = 18.sp
                )
                Text(
                    text = "✕",
                    color = Color.LightGray,
                    fontSize = 18.sp,
                    modifier = Modifier.clickable { onClose() }
                )
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Gem balance readout
            Row(
                modifier = Modifier
                    .background(Color(0xFF12131A), RoundedCornerShape(8.dp))
                    .padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text("💎", fontSize = 16.sp)
                Text(
                    text = "$gemBalance GEMS",
                    color = Color(0xFFE0FFFF),
                    fontWeight = FontWeight.Bold,
                    fontSize = 15.sp
                )
            }

            Spacer(modifier = Modifier.height(24.dp))

            // Exact mandated text
            Text(
                text = "The Gem Store is being prepared.",
                color = Color.LightGray,
                fontSize = 14.sp
            )

            Spacer(modifier = Modifier.height(24.dp))

            Box(
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(Color(0xFF333644))
                    .clickable { onClose() }
                    .padding(horizontal = 24.dp, vertical = 10.dp)
            ) {
                Text("BACK TO GAME", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 12.sp)
            }
        }
    }
}

@Composable
fun InventoryPanel(
    inventory: Map<String, Int>,
    onSelectItem: (String) -> Unit,
    onClose: () -> Unit
) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0x99000000))
            .clickable { onClose() },
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier
                .width(460.dp)
                .height(300.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF222430))
                .border(2.dp, Color(0xFF4CAF50), RoundedCornerShape(12.dp))
                .clickable(enabled = false) {}
                .padding(16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "INVENTORY",
                    color = Color(0xFF81C784),
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp
                )
                Text(
                    text = "✕",
                    color = Color.LightGray,
                    fontSize = 16.sp,
                    modifier = Modifier.clickable { onClose() }
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            val itemsList = listOf(ItemIds.FIST) + inventory.keys.filter { it != ItemIds.GEM }

            LazyVerticalGrid(
                columns = GridCells.Fixed(4),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.weight(1f)
            ) {
                items(itemsList) { itemId ->
                    val def = ItemDatabase.ITEMS[itemId]
                    val count = inventory[itemId] ?: 0
                    val isFist = itemId == ItemIds.FIST

                    Box(
                        modifier = Modifier
                            .height(64.dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(Color(0xFF2E3242))
                            .border(1.dp, Color(0xFF4A4E62), RoundedCornerShape(6.dp))
                            .clickable {
                                onSelectItem(itemId)
                                onClose()
                            }
                            .padding(4.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(def?.displayName ?: itemId, color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            if (!isFist) {
                                Text(
                                    text = "x$count",
                                    color = Color(0xFFA5D6A7),
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.SemiBold
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun SeedPotInfoPanel(
    pot: SeedPot,
    onHarvest: () -> Unit
) {
    val isMature = pot.isMature()
    val remainingSec = pot.getRemainingSeconds()
    val seedName = pot.seedDef?.displayName ?: "Seed Pot"

    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xDD1E1E24))
            .border(1.5.dp, if (isMature) Color(0xFFFFEB3B) else Color(0xFF81C784), RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp)
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (pot.isEmpty) {
                Text("Empty Seed Pot — select a Seed to plant", color = Color.LightGray, fontSize = 11.sp)
            } else if (isMature) {
                Text("$seedName: READY TO HARVEST", color = Color(0xFFFFEB3B), fontWeight = FontWeight.Bold, fontSize = 11.sp)
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(Color(0xFF4CAF50))
                        .clickable { onHarvest() }
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text("HARVEST", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 10.sp)
                }
            } else {
                Text("$seedName: ${remainingSec}s remaining", color = Color.White, fontSize = 11.sp)
            }
        }
    }
}
