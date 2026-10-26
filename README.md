# Better Combat Sheets

Run the whole fight from one window. Every NPC in the active combat becomes a browser-style tab above the character sheet: click to switch, let it follow the turn order, and keep the table clean.

![Foundry v13](https://img.shields.io/badge/Foundry-v13-informational) ![Foundry v14](https://img.shields.io/badge/Foundry-v14-informational)

## Features

- Every actor that the GM controls in combat appears as a tab on top of the current character sheet, like browser tabs! You can easily switch between them!
  - Double-clicking a token on the map jumps to its sheet
  - An orange stripe marks whose turn it is; defeated NPCs grey out
  - Tabs are sorted by initiative and show actor names; duplicates are told apart by token name on hover
  - NPCs joining or leaving the combat add or remove their tabs automatically
- On an NPC's turn, their sheet opens by itself; any player controlled actors are skipped
- Clicking the scene tucks the open sheet away into the tab row, this enables you to quickly look around or use targeting without having to manually minimize or close the sheet
- A special size slider allows you to change the size of all character sheets in combat (also a toggle option for out of combat as well)
  - Everything is resized, not only the dimensions of the sheet

An actor counts as an NPC when no player has Owner permission on it, counting default permissions. Works with any game system whose sheets can be minimized. GM-side only: players never see any of it, and your world data is never touched.

## Installation

In Foundry, open **Add-on Modules > Install Module** and paste this manifest URL:

```
https://github.com/The-Final-Artificer/better-combat-sheets/releases/latest/download/module.json
```

Then enable **Better Combat Sheets** in your world's Manage Modules.

Manual alternative: download `module.zip` from the latest release and extract it into your Foundry `Data/modules/better-combat-sheets` folder.

## Settings

All settings are per user:

- **Follow the turn order**: switch to the current combatant's sheet on turn change
- **Include player characters**: give player-owned combatants tabs too
- **Minimize on canvas clicks**: clicking the scene folds the open sheet into the tab row
- **Close defeated combatants**: close a sheet automatically when its combatant is marked defeated
- **Match window size across tabs**: one shared window size for every tab (hidden on systems that size their own sheets)
- **Sheet size**: zoom sheets from 50% to 200%, with **Scale sheets outside combat** controlling whether it applies everywhere

## Author

The Final Artificer
