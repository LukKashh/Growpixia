# GrowPixel — Compiled Implementation Requirements & 5-Gem Sprite Sheet Plan

This plan addresses all 11 requirements from `growpixel_compiled_requirements_666b314b.txt` and integrates the newly provided 5-gem sprite sheet (`IMG_20261030_231602_0e064a1a.jpg`).

---

## User Review & Critical Decisions

> [!IMPORTANT]
> **Key Architecture Decisions Based on Compiled Requirements**:
>
> 1. **Block Breaking Duration & Hold Interaction**:
>    - Mining now requires holding the click/touch down on the block.
>    - Breaking speed is governed by block hardness (`progress += dt / (hardness * 2.35)`).
>    - Progressive crack overlay renders across 4 visual fracture stages throughout the entire process.
>
> 2. **Block Placement Bug Fix (Position Reset)**:
>    - Root cause: React's `useEffect` was re-triggering on `currentUser` inventory mutations, which re-mounted the canvas and reset the player to spawn coordinates.
>    - Fix: Decouple the canvas lifecycle from inventory updates using mutable refs (`userInventoryRef`), preserving player position, velocity, and world state on placement.
>
> 3. **Indestructible Spawn Door Block (`spawn_door`)**:
>    - System-generated at ground level (`surf * TILE - TILE`) during world creation.
>    - Acts as a background walk-through fixture (`solid: false`).
>    - Permanent bedrock-tier protection (`hard: 9999`): no player can mine or replace it.
>    - Punching the spawn door while standing near it triggers the Leave World / Return to Hub prompt.
>
> 4. **Fixed 3-Slot Recent-Item Toolbar & Separate Fist**:
>    - Fixed capacity of exactly 3 slots for recent items + 1 permanent separate Fist button + 1 Inventory drawer button.
>    - When an item reaches 0 count, its slot clears back to an empty slot immediately.
>    - Replaced numerical key labels with down-scaled exact in-world block and lock textures.
>
> 5. **Lock Placement Claim Clamping & Inventory Return**:
>    - Disallow placing a lock inside an existing protected area.
>    - If a new lock's perimeter borders an existing lock, clamp its bounding box to the existing boundary so claims never overlap.
>    - Only the original owner can break their lock; upon breaking, the lock returns directly to the player's inventory.
>
> 6. **5-Variety Gem Sprite Sheet Integration**:
>    - Asset: `/public/assets/aistudio/IMG_20261030_231602_0e064a1a.jpg`
>    - Dark `#272727` background keyed out to transparent alpha 0.
>    - 5 slices:
>      - **Yellow Gem** (Col 1): Denomination 1
>      - **Cyan Gem** (Col 2): Denomination 5
>      - **Red Gem** (Col 3): Denomination 10
>      - **Green Gem** (Col 4): Denomination 50
>      - **Magenta / Purple Gem** (Col 5): Denomination 100

---

## 1. Overview & Core Gameplay Updates

- **Gameplay Flow**: Players spawn at a designated ground-level Spawn Door. Players can explore, farm, mine blocks with progressive hold-to-break mechanics, collect animated 5-denomination gems, build bases without position resets, and lock territory with non-overlapping Small, Medium, Big, or World Locks.
- **Spawn Door**: Serves as the immutable world anchor. Punching the door prompts the player to safely exit back to the World Menu Hub.

---

## 2. User Experience & Visual Design

### A. Toolbar & Control Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│                        GrowPixel Toolbar Layout                        │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   ┌──────────┐   ┌──────────────┬──────────────┬──────────────┐  ┌───┐ │
│   │   FIST   │   │ Recent Slot 1│ Recent Slot 2│ Recent Slot 3│  │ ▦ │ │
│   │   ✊     │   │ [Dirt Block] │ [Small Lock] │   [EMPTY]    │  │BAG│ │
│   │(Separate)│   │  Count: 14   │   Count: 1   │              │  │   │ │
│   └──────────┘   └──────────────┴──────────────┴──────────────┘  └───┘ │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

- **Fist Control**: Separate distinct tactile button immediately to the left of the 3-slot row.
- **3-Slot Recent Items**:
  - Automatically holds up to 3 most recently selected or collected blocks/seeds/locks.
  - When an item count drops to 0, the slot clears to an empty dashed placeholder.
  - No numerical slot numbers; uses the exact scaled in-world textures (Dirt, Stone, Locks, Seed Pot, etc.).
- **Inventory Drawer**: Tapping the Bag icon opens the full inventory grid with all owned items.

### B. In-Game Menu & Fullscreen Toggle

- Menu contains:
  - ⛶ **Toggle Fullscreen** (switches `document.documentElement.requestFullscreen()` / `exitFullscreen()`).
  - 💎 **Gem Store** (purchase locks and tools).
  - 🚪 **Leave World & Back to Hub**.

---

## 3. Key Product Decisions & Trade-Offs

### Decision 1: Hold-to-Break Mining Engine
- **Approach**: Clicking and holding sets `mining = { tx, ty, progress }`. Each frame, `progress += dt / (hardness * 2.35)`. If the player releases or moves too far, mining resets.
- **Visuals**: Dynamic procedural fracture lines with 4 progressive stages rendered directly on the target tile.

### Decision 2: Decoupled State & Zero Rejoin on Placement
- **Approach**: Replace component-level dependencies in `useEffect` with `useRef` for inventory and player data. The game loop and WebSocket connection persist seamlessly through block placements and store purchases.

### Decision 3: Boundary Clamping for Adjacent Locks
- **Approach**: When calculating bounds for a new lock:
  ```typescript
  // Start with default radius
  let bounds = calculateBounds(type, tx, ty);
  // Clamp against every existing lock in the room
  for (const existing of room.locks) {
    if (existing.type === 'world_lock') continue;
    // If overlaps on any side, shrink bounds to meet border
    if (overlaps(bounds, existing.bounds)) {
      bounds = clampNonOverlapping(bounds, existing.bounds, tx, ty);
    }
  }
  ```
- **Why**: Allows players to build adjacent locked rooms sharing a boundary wall without overlapping permissions.

### Decision 4: Official 5-Gem Sprite Sheet
- **Approach**: Offscreen canvas processing keys out the `#272727` background from `IMG_20261030_231602_0e064a1a.jpg`, generating 5 transparent sprite canvases for Yellow (1), Cyan (5), Red (10), Green (50), and Purple (100).

---

## 4. Technical Architecture & Component Mapping

```
┌────────────────────────────────────────────────────────────────────────┐
│                       System Architecture Updates                       │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   src/App.tsx                                                          │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │  Canvas Engine (Decoupled lifecycle: zero placement resets)    │   │
│   │  - Hold-to-break mining loop + progressive crack overlays      │   │
│   │  - System Spawn Door rendering + proximity punch exit trigger  │   │
│   │  - 5-Variety Gem sprite loader (transparent background)        │   │
│   │  - Exact in-world texture renderer for 3-slot toolbar items    │   │
│   └───────────────────────────────┬────────────────────────────────┘   │
│                                   │                                    │
│                                   ▼                                    │
│   server.ts                                                            │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │  - Spawn Door generation at (x=8, y=surf-1)                    │   │
│   │  - Bedrock-grade protection for spawn_door                     │   │
│   │  - Lock claim clamping (zero overlap allowed)                  │   │
│   │  - Lock break: verifies owner & refunds lock to inventory      │   │
│   └────────────────────────────────────────────────────────────────┘   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Execution Steps

1. **Server Updates (`server.ts`)**:
   - Add `spawn_door` block definition (`solid: false`, `hard: 9999`, indestructible).
   - Generate `spawn_door` at world surface in `generateWorldTiles` and ensure it can never be broken or overwritten.
   - Implement lock boundary clamping to prevent overlapping claims.
   - Update `block:mine` to refund destroyed locks to the owner's account inventory.

2. **Gem Sprite Sheet Loader (`src/App.tsx`)**:
   - Load `/public/assets/aistudio/IMG_20261030_231602_0e064a1a.jpg`.
   - Key out dark background and slice 5 transparent gem textures (Yellow, Cyan, Red, Green, Purple).
   - Update `drawGemPickup` to use these 5 sprite textures with floating bob animation.

3. **Mining Engine & Hold-to-Break Cracks**:
   - Restore continuous hold-to-break tracking in pointer events and frame loop.
   - Render multi-stage procedural fracture lines while holding.

4. **Block Placement Fix**:
   - Refactor canvas initialization `useEffect` so `currentUser` updates do not reset player position or trigger reconnects.

5. **Spawn Door Visuals & Interaction**:
   - Draw authentic arched wooden world entrance door with brass fixtures at spawn.
   - Punching door opens prompt to return to World Hub.

6. **Toolbar & Fist Redesign**:
   - Restructure toolbar into: Separate Fist button + Fixed 3-Slot Recent Items + Inventory Bag button.
   - Render exact scaled world textures in slots instead of slot numbers.
   - Automatically clear slots when item count reaches 0.

7. **Menu Fullscreen Option**:
   - Add accessible "⛶ Toggle Fullscreen" button in in-game menu.

8. **Verification**:
   - Verify hold-to-break duration and cracks on dirt/stone.
   - Verify placing blocks does not reset player position.
   - Verify 5-gem textures in world drops and pickups.
   - Verify 3-slot toolbar, empty slot restoration, and lock refunding.
