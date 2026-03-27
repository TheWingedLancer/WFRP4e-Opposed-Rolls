# Changelog

## [1.3.0] - 2026-03-25

### Changed
- **Native WFRP4e roll dialog** — All rolls now use `actor.setupSkill()` / `actor.setupCharacteristic()` instead of plain d100 rolls. Participants see the full WFRP4e roll window with modifiers, difficulty selection, and talent bonuses.
- **Socket-based player roll delegation** — When a player-owned token needs to roll, a socket message opens the native roll dialog on that player's screen. The result is sent back to the GM via socket. This replaces the old whispered chat-card button approach.
- **Sequential rolling** — Rolls are performed one at a time (rather than in parallel) to avoid overlapping dialog windows.
- **`socket: true`** in `module.json` — Required for the new cross-client roll delegation.
- **Roll timeout increased** to 2 minutes (from 30 seconds) to accommodate the native dialog workflow.
- **SL is now read from the WFRP4e test result** rather than calculated manually. This means all system rules (Fast SL, Tests Above 100%, etc.) are respected automatically.
- **Removed old roll-request chat card listener** — The `tanglefoot` flag-based chat button system is no longer used.
- **Version bumped to 1.3.0.**

## [1.2.0] - 2026-02-25

### Fixed
- **renderChatMessage → renderChatMessageHTML** — Replaced deprecated v13 hook. The `html` argument is now an `HTMLElement` (not jQuery), eliminating deprecation warnings.
- **DialogV2 render callback** — Updated to use the v13 signature where the second argument is the `DialogV2` instance (not its element).
- **Double wound application in grapple damage** — `applyDamage()` and manual wound reduction no longer both execute; manual calculation is now a fallback only.
- **applyStackedChange await bug** — `actor.addCondition()` is now properly awaited with a `typeof` guard instead of the broken `await fn && fn()` pattern.
- **Macro name typo** — Changed "WFRP43" to "WFRP4e" (now localized).
- **DAMAGE_TYPE null guard** — Added optional chaining for `game.wfrp4e.config.DAMAGE_TYPE.IGNORE_AP`.

### Added
- **Localization** — All user-facing strings extracted to `lang/en.json` using `game.i18n.localize()` / `game.i18n.format()`. Community translations can now be added.
- **XSS escaping** — Token names and labels are HTML-escaped before interpolation into chat cards.
- **JSDoc comments** — Public API (`runOpposedTest`) and key helpers are documented.
- **Repository scaffolding** — README, LICENSE, CHANGELOG, .gitignore.

### Changed
- **Helper functions moved to module scope** — `getCharacteristicValue`, `inferSkillCharacteristic`, `getSkillValue`, `getActiveOwner`, `calcSL`, `waitForResult`, and `requestRoll` are no longer recreated on each invocation.
- **Module-scoped listener guard** — Replaced `game._wfrp4eOpposedListenerReady` global with a module-scoped `let listenerInstalled` variable.
- **Option set storage** — Replaced fragile `data-char`/`data-skill` attribute escaping with a closure-scoped `optionSets` map.
- **`randomID()` → `foundry.utils.randomID()`** — Uses the namespaced v13 API.
- **Version bumped to 1.2.0.**

## [1.1.0] - 2026-02-24

### Added
- Initial module with GM opposed test macro, player roll delegation, grapple and entangled test support.
