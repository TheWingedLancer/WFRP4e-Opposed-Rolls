# WFRP4e Opposed Tests

A [Foundry VTT](https://foundryvtt.com/) module for the **Warhammer Fantasy Roleplay 4th Edition** system that provides a streamlined GM workflow for resolving opposed tests — including **Grapple** and **Entangled** special cases.

## Features

- **Multi-token opposed tests** — Select 2+ tokens, pick a characteristic or skill for each, and roll.
- **Player roll delegation** — If a token is owned by a connected player, they receive a whispered roll button; GM-controlled tokens roll automatically.
- **SL comparison** — Success Levels are calculated and the winner/loser determined per WFRP4e rules (tie-breaking on higher target value).
- **Grapple actions** — Winner can deal SB + SL damage, apply Entangled to the loser, or remove Entangled from themselves.
- **Entangled actions** — Apply or remove stacking Entangled conditions on any participant.
- **GM action buttons** — Results are whispered to the GM with clickable action buttons.
- **Localization-ready** — All user-facing strings use `game.i18n` and can be translated.

## Requirements

- Foundry VTT **v13** (verified 13.351)
- WFRP4e game system

## Installation

### Manual

1. Download the [latest release](https://github.com/TheWingedLancer/WFRP4e-Opposed-Rolls/releases/latest) zip file.
2. Extract it into your `{userData}/Data/modules/` directory.
3. Enable **WFRP4e Opposed Tests** in your world's Module Management.

### Manifest URL

In Foundry's **Add-on Modules** → **Install Module**, paste the manifest URL:

```
https://raw.githubusercontent.com/TheWingedLancer/WFRP4e-Opposed-Rolls/main/module.json
```

## Usage

1. As GM, select **2 or more tokens** on the canvas.
2. Run the **WFRP4e Opposed Test (GM)** macro (auto-created on module load).
3. In the dialog, choose **Characteristic** or **Skill** for each participant.
4. Optionally check **Grapple Test** or **Entangled Test**.
5. Click **Roll** — rolls are performed (or delegated to players).
6. Results appear in chat; GM receives a whispered card with action buttons.

## Localization

The module ships with English (`lang/en.json`). To add a translation, create a new JSON file (e.g., `lang/de.json`) with the same keys and submit a pull request.

## License

[MIT](LICENSE)
