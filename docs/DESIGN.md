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

- **Fixed starting resources, split to fight the outbreak.** The player starts
  with a specific pool and decides where it goes. *(Resource list still open.)*
- **Survivors can be turned into Militia.**
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
  | Police | blue |
  | Militia | *(proposed: amber)* |
  | Military (dropped units) | *(proposed: olive / tan)* |

  Proposed entries need sign-off. Zombie green is already the palette's
  `zombieGreen`.
