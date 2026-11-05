package com.growpixel.game.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.growpixel.game.game.items.ItemDatabase
import com.growpixel.game.game.items.ItemIds
import kotlin.math.roundToInt

@Composable
fun JoystickControl(
    modifier: Modifier = Modifier,
    onMove: (Float) -> Unit
) {
    var knobOffset by remember { mutableStateOf(Offset.Zero) }
    val maxRadius = 45f

    Box(
        modifier = modifier
            .size(110.dp)
            .clip(CircleShape)
            .background(Color(0x55000000))
            .border(2.dp, Color(0x884CAF50), CircleShape)
            .pointerInput(Unit) {
                detectDragGestures(
                    onDragStart = {},
                    onDragEnd = {
                        knobOffset = Offset.Zero
                        onMove(0f)
                    },
                    onDragCancel = {
                        knobOffset = Offset.Zero
                        onMove(0f)
                    },
                    onDrag = { change, dragAmount ->
                        change.consume()
                        val newX = (knobOffset.x + dragAmount.x).coerceIn(-maxRadius, maxRadius)
                        // Allow vertical movement for comfortable thumb freedom, but do NOT cancel horizontal axis!
                        val newY = (knobOffset.y + dragAmount.y).coerceIn(-maxRadius, maxRadius)
                        knobOffset = Offset(newX, newY)

                        val normalizedX = (newX / maxRadius).coerceIn(-1f, 1f)
                        onMove(normalizedX)
                    }
                )
            },
        contentAlignment = Alignment.Center
    ) {
        Box(
            modifier = Modifier
                .offset { IntOffset(knobOffset.x.roundToInt(), knobOffset.y.roundToInt()) }
                .size(46.dp)
                .clip(CircleShape)
                .background(Color(0xDD81C784))
                .border(2.dp, Color.White, CircleShape)
        )
    }
}

@Composable
fun JumpButton(
    modifier: Modifier = Modifier,
    onJump: () -> Unit
) {
    Box(
        modifier = modifier
            .size(76.dp)
            .clip(CircleShape)
            .background(Color(0x66000000))
            .border(2.dp, Color(0xFF64B5F6), CircleShape)
            .pointerInput(Unit) {
                detectTapGestures(
                    onPress = {
                        onJump()
                    }
                )
            },
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = "JUMP",
            color = Color.White,
            fontWeight = FontWeight.Bold,
            fontSize = 14.sp
        )
    }
}

@Composable
fun Hotbar(
    modifier: Modifier = Modifier,
    selectedItemId: String,
    inventoryQuantities: Map<String, Int>,
    onSelectSlot: (String) -> Unit,
    onOpenInventory: () -> Unit
) {
    // Hotbar layout: Slot 1: Fist, Slot 2 & 3: Selected items/blocks, Slot 4: Permanently INVENTORY
    val slot2Item = ItemIds.DIRT
    val slot3Item = ItemIds.SEED_POT

    Row(
        modifier = modifier
            .background(Color(0xCC1E1E24), RoundedCornerShape(8.dp))
            .border(2.dp, Color(0xFF3F424E), RoundedCornerShape(8.dp))
            .padding(4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Slot 1: FIST (Always default tool)
        HotbarSlot(
            title = "Fist",
            count = null,
            isSelected = selectedItemId == ItemIds.FIST,
            onClick = { onSelectSlot(ItemIds.FIST) }
        )

        // Slot 2: Dirt
        HotbarSlot(
            title = "Dirt",
            count = inventoryQuantities[slot2Item] ?: 0,
            isSelected = selectedItemId == slot2Item,
            onClick = { onSelectSlot(slot2Item) }
        )

        // Slot 3: Seed Pot
        HotbarSlot(
            title = "Pot",
            count = inventoryQuantities[slot3Item] ?: 0,
            isSelected = selectedItemId == slot3Item,
            onClick = { onSelectSlot(slot3Item) }
        )

        // SLOT 4: ALWAYS DEDICATED INVENTORY ACTION (Fixed position, never moves)
        Box(
            modifier = Modifier
                .size(52.dp)
                .clip(RoundedCornerShape(6.dp))
                .background(Color(0xFF2C3E50))
                .border(2.dp, Color(0xFF3498DB), RoundedCornerShape(6.dp))
                .clickable { onOpenInventory() },
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("🎒", fontSize = 16.sp)
                Text("BAG", color = Color.White, fontSize = 9.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

@Composable
private fun HotbarSlot(
    title: String,
    count: Int?,
    isSelected: Boolean,
    onClick: () -> Unit
) {
    val borderColor = if (isSelected) Color(0xFFFFEB3B) else Color(0xFF555555)
    val bgColor = if (isSelected) Color(0x44FFEB3B) else Color(0x882A2A2A)

    Box(
        modifier = Modifier
            .size(52.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(bgColor)
            .border(2.dp, borderColor, RoundedCornerShape(6.dp))
            .clickable { onClick() }
            .padding(2.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text(title, color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.SemiBold)
            if (count != null) {
                Text(
                    text = count.toString(),
                    color = Color(0xFFA5D6A7),
                    fontSize = 9.sp,
                    fontWeight = FontWeight.Bold
                )
            }
        }
    }
}
