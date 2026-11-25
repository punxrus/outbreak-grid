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
- **Fixed starting resources, split to fight the outbreak:** Money, Survivors,
  Ammo, Fuel, Medical, Food (`campaign.json` → `startingResources`).
- **Outcome is the percentage of survivors saved** once the zombies are cleared.
  Below the minimum (placeholder 50%) the stage is lost even if every zombie
  dies. Grades: Flawless ≥90%, Decisive ≥70%, Secured ≥50%.
- **Survivors can be turned into Militia.**
- **Hunters:** rural locals recruited from survivors who bring their hunting
  skills. They track outlying zombies within about 1.5 km of where they are
  placed, carry limited ammo (15 rounds each), and have light armor.
- **Police stations produce one officer every 30 s** (up to 4 for a small-town
  station, 30 rounds each). Officers patrol around their station. Once the
  outbreak comes over the radio (about 10 s after the first infection), they
  drive toward it and fight it.
- **Militia engage early:** within 600 m of their post.
- **Ammo is split, not pooled:** each squad carries what it was issued. Unissued
  ammo is the reserve. With a safe zone, the zone is the depot: units restock
  inside it, and units that run dry go back for more. Without a zone, the reserve
  is shared out at the start, capped at 1.5x each unit's issue.
- **Containment win:** once every living survivor has been inside an unbreached
  zone with no zombies for 60 s, the outbreak is contained and the battle ends,
  scored on survivors saved.
- **Starting roster (Forks):** limited militia (4 squads) and at most 2 hunter
  squads. Paratroopers, EOD, mortars, artillery, drones and helicopters are not
  available at the start; they unlock later in the campaign.
- **Drop-ins:** specific weapon types and military personnel can be dropped
  into areas:
  - Paratroopers
  - EOD (explosive ordnance disposal)
  - Mortar teams
  - Heavy artillery
  - Drone squads (gun drones, plus FPV kamikaze drones with explosives)
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
  | FPV drone (launched by drone squads) | pale violet `#e6ccff` |
  | Attack helicopter | red `#ff3b3b` |

  Every unit type has its own color (`src/config/units.json`). None is close to
  zombie green or the cyan wireframe.

## Safe zones

- **The core of a defense:** a secure area survivors run to, and a place to defend.
- **Drawing:** click points around an area and close the loop.
- **Walls cost money per meter.** Where the line passes through a building, the
  building takes the place of that wall section and costs nothing.
- **Gates cost money each.** People pass through them; zombies don't.
- **In battle:** survivors flock to the zone (running while far away), zombies
  pile up against the wall nearest the people inside, and wall sections lose
  hit points until they breach.
- **Gunfire is visible** as tracers in the shooter's color. Drone teams also
  launch FPV kamikaze drones.
