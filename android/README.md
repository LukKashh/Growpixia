# GrowPixel — Native Android Game (Pixel Sandbox)

GrowPixel is an offline, 2D side-view pixel sandbox game developed for Android using **Kotlin** and **Jetpack Compose**.

## Architecture & Project Structure
```
android/
├── app/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml          # Sensor landscape, no unnecessary internet permissions
│       └── java/com/growpixel/game/
│           ├── MainActivity.kt          # Immersive sticky landscape host activity
│           ├── game/
│           │   ├── items/
│           │   │   ├── ItemDatabase.kt  # Central definitions & independent drop probabilities
│           │   │   └── DropSystem.kt    # Independent block/seed rolls & 0..3 Gem rolls
│           │   ├── objects/
│           │   │   └── SeedPot.kt       # 30s tree growth timers & exact harvest yields
│           │   ├── player/
│           │   │   ├── Player.kt        # 3-tile reach validation & directional punch state
│           │   │   └── PlayerPhysics.kt # 2D platform physics & tile collision
│           │   ├── render/
│           │   │   ├── Camera2D.kt      # Smooth camera follow with look-ahead
│           │   │   ├── GamePalettes.kt  # Pixel art color system
│           │   │   └── WorldRenderer.kt # Compose Canvas renderer
│           │   └── world/
│           │       └── WorldGenerator.kt# Deterministic seed terrain generator
│           └── ui/
│               ├── GameRoot.kt          # Main game loop, canvas & state
│               ├── GameHud.kt           # Gem Store, Inventory, and Seed Pot panels
│               └── TouchControls.kt     # Large horizontal joystick & Hotbar (Slot 4 = Bag)
├── build.gradle.kts
└── settings.gradle.kts
```

## Exact Mechanics Implemented

1. **Exact Block Drop & Seed Probabilities (Independent Rolls)**:
   - **Dirt**: 30% block, 20% seed
   - **Stone**: 20% block, 12.5% seed
   - **Wood**: 20% block, 15% seed (Walk-through background block)
   - **Leaves**: 15% block, 10% seed (Solid block)
   - **Sand**: 20% block, 10% seed
   - **Lava**: 20% block, 22.5% seed (Solid collision)
   - **Seed Pot**: 100% return of 1 Seed Pot
   - **Bedrock**: Indestructible boundary block

2. **Gem Economy**:
   - Every broken breakable block rolls `Random.nextInt(0, 4)` (0, 1, 2, or 3 inclusive).
   - If > 0, spawns a physical Gem pickup stack in the world.
   - Bedrock & tree harvesting award 0 Gems.
   - Gems are collected when the player walks over them.

3. **Seed Pots & Tree Growth**:
   - 10 starting Seed Pots in new world inventory.
   - Pots are walk-through and breakable (guaranteed 100% return).
   - Planted seeds grow for exactly **30 seconds**.
   - One-tap harvest yields configured ranges:
     - Dirt Tree: 2–6 Dirt
     - Stone Tree: 1–3 Stone
     - Wood Tree: 1–3 Wood
     - Leaves Tree: 2–7 Leaves
     - Sand Tree: 2–5 Sand
     - Lava Tree: 1–5 Lava

4. **HUD Layout**:
   - **Top-Left**: GEM STORE banner button opening "The Gem Store is being prepared."
   - **Top-Right**: Compact Menu button (no world status pill, no bag button).
   - **Bottom-Center**: Hotbar with Slot 1 Fist, and **Slot 4 permanently dedicated to Inventory**.
   - **Lower-Left**: Large horizontal joystick (vertical thumb movement does not cancel horizontal input).
   - **Lower-Right**: Jump button.
