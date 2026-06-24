# Changelog

## [1.5.0] - 2026-06-23

### Changed
- **Foundry v14 compatibility.** `module.json` compatibility raised to `verified: "14"` with `minimum: "13"` retained for best-effort v13 support. No core-API breaks were found: the module already uses the v13-modern surfaces (`DialogV2`, `renderChatMessageHTML`, native DOM, `foundry.utils.randomID()`) that v14 expects.
- **Document globals routed through `CONFIG`.** `ChatMessage` and `Macro` statics now resolve via `CONFIG.ChatMessage.documentClass` / `CONFIG.Macro.documentClass` instead of the bare top-level globals, which Foundry is progressively removing. Behaviour is identical on v13 and v14.

### Added
- **System-API mismatch guard.** Roll-result extraction now detects an empty/unrecognised WFRP4e test result (e.g. if a future system version relocates `result.SL` / `result.roll` / `result.target`) and surfaces it as a console error plus GM notification, instead of silently reporting a phantom draw. New string `error.resultParse`.

### Notes
- The WFRP4e **system** test/dialog API (`setupCharacteristic` / `setupSkill`, the `options.fields` and `skipTargets` shape, and `test.result`) is owned by the system and must be smoke-tested against the system build that pairs with v14. See README "v14 verification checklist".

## [1.3.1] - 2026-03-26

### Fixed
- **Grapple damage now applies correctly.** Removed the fake `applyDamage()` call that was passing an incomplete opposed test object, causing `wounds.value: must be a finite number` validation errors and `Cannot read properties of undefined (reading 'defenderTest')` errors from the WFRP4e advantage hooks. Grapple damage is now calculated directly as SB + SL diff - TB and applied via a clean wound update.
- **Damage breakdown shown in chat.** Grapple damage messages now include a breakdown line (e.g., "SB 4 + SL diff 3 - TB 3") so the GM can verify the calculation.
- **Removed unused `resolveHitLocKey` function** (no longer needed without the fake `applyDamage` call).

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
