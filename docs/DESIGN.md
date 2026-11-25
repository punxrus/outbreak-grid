# Outbreak Grid: design notes

Decisions from design conversations, kept with the code. "Built" means it's in
the repo; everything else is direction for upcoming milestones.

## Campaign

- **Route along real highways.** Coast (Forks → Montesano → Olympia), then I-5
  North (Tacoma → … → Bellingham) and I-5 South (Centralia → … → Vancouver).
  *Built:* `src/config/campaign.json`.
- **Player's choice at Olympia.** Both directions open; taking one doesn't close
  the other. *Built:* `next` graph + `src/campaign/state.ts`.
- **Forks is the tutorial.** A small, isolated town with a small outbreak, so the
  pace can build and the systems can be taught.
- **Secured regions become holdings.** They stay assets and production sources
  after the player leaves, but don't need to be visible. *Built:* a snapshot
  (population, buildings, key sites); production rules come with the economy.
- **Required sites per stage.** Forks always has a hospital. Fuel is deliberately
  not guaranteed. *Built:* `"sites"` in the stage config.
- **Setpieces and named battles.** Montesano's stage includes Satsop. Part of the
  stage is **"The Battle for Satsop"**, at the unfinished WNP-3/WNP-5 nuclear
  plant with its two cooling towers. *Built:* `"extraPlaces"`, `"zones"`, the
  `cooling_tower` site at the real location (46.9598 N, 123.4696 W), and a world
  anchor that makes the plant site industrial on every seed.

## Resources and forces

- **Core loop: place, then auto-battle.** In the prep phase the player spends
  the pool by placing squads on the map. Then the battle runs on its own:
  zombies spread, civilians flee, units fight by their own rules.
- **Fixed starting resources, split to fight the outbreak:** Survivors, Ammo,
  Fuel, Medical, Food (`campaign.json` → `startingResources`).
- **Outcome is the percentage of survivors saved** once the zombies are cleared.
  Below the minimum (placeholder 50%) the stage is lost even if every zombie
  dies. Grades: Flawless ≥90%, Decisive ≥70%, Secured ≥50%.
- **Survivors can be turned into Militia.**
- **Hunters:** rural locals recruited from survivors who bring their hunting
  skills. They free-roam the whole map tracking down outlying zombies (no leash),
  with long rifles but light armor.
- **Police stations produce police officers.**
- **Drop-ins:** specific weapon types and military personnel can be dropped
  into areas:
  - Paratroopers
  - EOD (explosive ordnance disposal)
  - Mortar teams
  - Heavy artillery
  - Drone squads
  - Attack helicopters

## Look

- **Wireframe city:** outlines only, roads read as gaps between blocks. *Built.*
- **People are small colored dots,** where color says who they are:

  | Who | Color |
  |---|---|
  | Zombie | bright green `#39ff14` |
  | Survivor | white `#ffffff` |
  | Police | blue `#3d8bff` |
  | Militia | amber `#ffb347` |
  | Hunters | blaze orange `#ff6f00` |
  | Paratroopers | tan `#d9c08c` |
  | EOD | yellow `#fff176` |
  | Mortar team | brass `#c9a227` |
  | Heavy artillery | magenta `#ff4fd8` |
  | Drone squad | violet `#b388ff` |
  | Attack helicopter | red `#ff3b3b` |

  Every unit type has its own color (`src/config/units.json`). None is close to
  zombie green or the cyan wireframe.
