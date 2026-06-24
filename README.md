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

- Foundry VTT **v13 or v14** (verified on v14; v13 best-effort, verified 13.351)
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

## v14 verification checklist

The core-Foundry surface is v14-ready, but the module calls into the WFRP4e
**system** for rolls. Confirm these against the system build you run on v14:

1. **`actor.setupCharacteristic(key, options)` / `actor.setupSkill(name, options)`**
   still return a test object you can `await test.roll()` on.
2. **`options.fields` shape** — the module passes `{ fields: { difficulty, modifier }, skipTargets: true, appendTitle }`. Verify the system still reads `fields.difficulty` / `fields.modifier` and still honours `skipTargets` (the WFRP4e dialog moved to ApplicationV2; option nesting may have shifted).
3. **`test.result`** — extraction reads `result.SL`, `result.roll`, `result.target` and `test.succeeded`. The new guard will log an error + notify the GM if these come back empty.
4. **Condition API** — `actor.hasCondition(key)`, `actor.addCondition(key)`, and `effect.system.condition.value` for Entangled stacking.
5. **Difficulty config** — `game.wfrp4e.config.difficultyLabels` still populates the dialog dropdown.

## License

[MIT](LICENSE)
