// WFRP4e Opposed Tests module for Foundry VTT v13
// GM macro + chat listener/action handlers for opposed tests,
// including Grapple and Entangled special-case resolution.
//
// Rolls use the native WFRP4e roll dialog (setupSkill / setupCharacteristic)
// so participants can adjust modifiers, difficulty, and talent bonuses.
// For player-owned tokens the dialog is opened on the player's client via
// socket messaging; for GM-controlled tokens it opens on the GM's screen.

const MODULE_ID = "wfrp4e-opposed-tests";
const SOCKET_ID = `module.${MODULE_ID}`;
const MACRO_TYPE = "script";
const ROLL_TIMEOUT_MS = 120000; // 2 min — native dialog takes longer than a quick click

// ---------------------------------------------------------------------------
// Localization helper
// ---------------------------------------------------------------------------

function loc(key, data) {
  const fullKey = key.startsWith(MODULE_ID) ? key : `${MODULE_ID}.${key}`;
  return data ? game.i18n.format(fullKey, data) : game.i18n.localize(fullKey);
}

// ---------------------------------------------------------------------------
// HTML-escape helper (XSS safety)
// ---------------------------------------------------------------------------

function esc(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Document class accessors
// ---------------------------------------------------------------------------
// Foundry is progressively removing bare top-level document globals
// (ChatMessage, Macro, ...) in favour of namespaced / CONFIG access.
// CONFIG.<Doc>.documentClass resolves to the *configured* (system-extended)
// class and is stable across v13 and v14, so we route document statics
// through it rather than the globals.

function ChatMessageCls() {
  return CONFIG.ChatMessage.documentClass;
}

function MacroCls() {
  return CONFIG.Macro.documentClass;
}

// ---------------------------------------------------------------------------
// Characteristic helpers
// ---------------------------------------------------------------------------

function getSB(actor) {
  const c = actor?.system?.characteristics?.s;
  const bonusRaw = c && (c.bonus ?? c.b);
  const bonus = Number(bonusRaw);
  if (Number.isFinite(bonus)) return bonus;
  const val = Number(c && (c.value ?? c.total));
  if (Number.isFinite(val)) return Math.floor(val / 10);
  return 0;
}

function getTB(actor) {
  const c = actor?.system?.characteristics?.t;
  const bonusRaw = c && (c.bonus ?? c.b);
  const bonus = Number(bonusRaw);
  if (Number.isFinite(bonus)) return bonus;
  const val = Number(c && (c.value ?? c.total));
  if (Number.isFinite(val)) return Math.floor(val / 10);
  return 0;
}

function getCharacteristicValue(actor, key) {
  const c = actor?.system?.characteristics?.[key];
  return Number(c && (c.value ?? c.total ?? c) || 0);
}

function inferSkillCharacteristic(skillName) {
  const n = (skillName || "").trim().toLowerCase();
  if (!n) return null;
  const skills = game.wfrp4e?.config?.skills || {};
  const skillKey = Object.keys(skills).find(k => (skills[k] || "").toLowerCase() === n) || null;
  if (!skillKey) return null;
  const mapA = game.wfrp4e?.config?.skillCharacteristics || {};
  const mapB = game.wfrp4e?.config?.skillToCharacteristic || {};
  return mapA[skillKey] || mapB[skillKey] || null;
}

function getSkillValue(actor, name) {
  const items = actor?.items?.contents || actor?.items || [];
  const skill = items.find(
    i => i.type === "skill" && i.name && i.name.toLowerCase() === (name || "").trim().toLowerCase()
  ) || null;
  if (skill) {
    const sys = skill.system || {};
    const total = Number(
      (sys.total && (sys.total.value ?? sys.total)) ?? (sys.value && (sys.value.value ?? sys.value))
    );
    if (Number.isFinite(total)) return total;
    const charKey = typeof sys.characteristic === "string" ? sys.characteristic : null;
    const charVal = Number(
      (sys.characteristic && sys.characteristic.value) ??
      (charKey && actor.system?.characteristics?.[charKey]?.value) ?? 0
    );
    const adv = Number((sys.advances && (sys.advances.value ?? sys.advances)) ?? 0);
    const base = charVal + adv;
    if (Number.isFinite(base)) return base;
  }
  const charKey = inferSkillCharacteristic(name);
  if (charKey) return getCharacteristicValue(actor, charKey);
  return NaN;
}

function getActiveOwner(actor) {
  const owners = game.users.players.filter(u => u.active && actor.testUserPermission(u, "OWNER"));
  return owners[0] ?? null;
}

function calcSL(rollTotal, target) {
  return Math.floor(target / 10) - Math.floor(rollTotal / 10);
}

// ---------------------------------------------------------------------------
// Condition stack helpers
// ---------------------------------------------------------------------------

async function applyStackedChange(actor, key, delta) {
  if (delta <= 0) return 0;
  let changed = 0;
  while (delta > 0) {
    const effect = typeof actor.hasCondition === "function" ? actor.hasCondition(key) : null;
    if (!effect) {
      if (typeof actor.addCondition === "function") await actor.addCondition(key);
    } else {
      const current = effect.system?.condition?.value || 1;
      await effect.update({ "system.condition.value": current + 1 });
    }
    changed += 1;
    delta -= 1;
  }
  return changed;
}

async function removeStackedChange(actor, key, delta) {
  if (delta <= 0) return 0;
  let changed = 0;
  while (delta > 0) {
    const effect = typeof actor.hasCondition === "function" ? actor.hasCondition(key) : null;
    if (!effect) break;
    const current = effect.system?.condition?.value || 1;
    if (current > 1) await effect.update({ "system.condition.value": current - 1 });
    else await effect.delete();
    changed += 1;
    delta -= 1;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Native WFRP4e roll execution (runs on the local client)
// ---------------------------------------------------------------------------

/**
 * Perform a WFRP4e roll using the native system dialog on the local client.
 * Works for both characteristics and skills via actor.setupCharacteristic()
 * or actor.setupSkill().
 *
 * @param {string} actorId    - The actor's document ID.
 * @param {string} mode       - "char" or "skill".
 * @param {string} pick       - Characteristic key (e.g. "ws") or skill name (e.g. "Athletics").
 * @param {string} title      - Appended to the dialog title for context.
 * @param {object} [fields]   - Pre-filled dialog fields from the GM (difficulty, modifier).
 * @returns {Promise<{sl: number, roll: number, target: number, succeeded: boolean}|null>}
 *   Null if the user cancelled the dialog.
 */
async function performLocalWfrpRoll(actorId, mode, pick, title, fields = {}) {
  const actor = game.actors.get(actorId);
  if (!actor) {
    console.warn(`${MODULE_ID} | Actor ${actorId} not found for local roll.`);
    return null;
  }

  const options = {
    skipTargets: true,
    appendTitle: ` - ${title}`,
    fields: {}
  };

  // Pre-fill difficulty and modifier if set by the GM
  if (fields.difficulty) options.fields.difficulty = fields.difficulty;
  if (fields.modifier) options.fields.modifier = fields.modifier;

  let test;
  try {
    if (mode === "char") {
      test = await actor.setupCharacteristic(pick, options);
    } else {
      test = await actor.setupSkill(pick, options);
    }
  } catch (e) {
    // User closed the dialog without rolling
    console.log(`${MODULE_ID} | Roll dialog cancelled for ${actor.name}.`);
    return null;
  }

  if (!test) return null;

  try {
    await test.roll();
  } catch (e) {
    console.warn(`${MODULE_ID} | test.roll() failed:`, e);
    return null;
  }

  // Extract results from the WFRP4e test object.
  // NOTE (v14 migration): the WFRP4e *system* owns the shape of `test.result`.
  // If a future system version relocates these fields, extraction silently
  // yields zeros and the opposed test reports a phantom draw. The guard below
  // surfaces that as a console error + GM notification so the mismatch is
  // visible during testing instead of producing a wrong outcome.
  const result = test.result || {};
  const sl = Number(result.SL ?? result.sl ?? 0);
  const roll = Number(result.roll ?? 0);
  const target = Number(result.target ?? 0);
  const succeeded = !!(test.succeeded ?? result.outcome === "success");

  if (!test.result || (roll === 0 && target === 0)) {
    console.error(
      `${MODULE_ID} | Could not read roll result from the WFRP4e test object. ` +
      `The system test API may have changed. Test object:`, test
    );
    ui.notifications?.error?.(loc("error.resultParse", { name: actor.name }));
  }

  return { sl, roll, target, succeeded };
}

// ---------------------------------------------------------------------------
// Socket-based roll delegation
// ---------------------------------------------------------------------------

// Pending roll requests keyed by requestId, resolved when the player responds
const pendingRollRequests = new Map();

/**
 * Handle an incoming socket message. Both GM and player clients listen.
 */
function handleSocketMessage(data) {
  if (!data || !data.action) return;

  // --- Player receives a roll request from the GM ---
  if (data.action === "rollRequest" && data.targetUserId === game.user.id) {
    handleIncomingRollRequest(data);
    return;
  }

  // --- GM receives a roll result from a player ---
  if (data.action === "rollResult" && game.user.isGM) {
    const pending = pendingRollRequests.get(data.requestId);
    if (pending) {
      pendingRollRequests.delete(data.requestId);
      pending.resolve(data.result);
    }
    return;
  }

  // --- GM receives a cancellation from a player ---
  if (data.action === "rollCancelled" && game.user.isGM) {
    const pending = pendingRollRequests.get(data.requestId);
    if (pending) {
      pendingRollRequests.delete(data.requestId);
      pending.resolve(null);
    }
    return;
  }
}

/**
 * On the player's client: receive a roll request, open the native dialog,
 * perform the roll, and send the result back via socket.
 */
async function handleIncomingRollRequest(data) {
  const { requestId, actorId, mode, pick, title, fields } = data;

  ui.notifications.info(loc("notify.rollRequested", { name: title }));

  const result = await performLocalWfrpRoll(actorId, mode, pick, title, fields || {});

  if (result) {
    game.socket.emit(SOCKET_ID, {
      action: "rollResult",
      requestId,
      result
    });
  } else {
    game.socket.emit(SOCKET_ID, {
      action: "rollCancelled",
      requestId
    });
  }
}

/**
 * Request a WFRP4e roll from a specific player via socket.
 *
 * @param {string} userId  - The target player's user ID.
 * @param {string} actorId - The actor to roll for.
 * @param {string} mode    - "char" or "skill".
 * @param {string} pick    - Characteristic key or skill name.
 * @param {string} title   - Context label for the dialog.
 * @param {object} [fields] - Pre-filled dialog fields (difficulty, modifier).
 * @returns {Promise<{sl: number, roll: number, target: number, succeeded: boolean}|null>}
 */
function requestRemoteRoll(userId, actorId, mode, pick, title, fields = {}) {
  return new Promise((resolve, reject) => {
    const requestId = foundry.utils.randomID();

    const timeoutId = setTimeout(() => {
      pendingRollRequests.delete(requestId);
      reject(new Error(loc("error.timeout", { label: title })));
    }, ROLL_TIMEOUT_MS);

    pendingRollRequests.set(requestId, {
      resolve: (result) => {
        clearTimeout(timeoutId);
        resolve(result);
      }
    });

    game.socket.emit(SOCKET_ID, {
      action: "rollRequest",
      requestId,
      targetUserId: userId,
      actorId,
      mode,
      pick,
      title,
      fields
    });
  });
}

/**
 * Perform a roll for a single participant.
 * If the actor is owned by an active player, the roll is delegated via socket.
 * Otherwise the GM performs it locally using the native WFRP4e dialog.
 */
async function rollForParticipant(actor, mode, pick, title, fields = {}) {
  const owner = getActiveOwner(actor);

  // Owner is another player — delegate via socket
  if (owner && owner.id !== game.user.id) {
    return await requestRemoteRoll(owner.id, actor.id, mode, pick, title, fields);
  }

  // GM rolls locally (or no active owner found)
  return await performLocalWfrpRoll(actor.id, mode, pick, title, fields);
}

// ---------------------------------------------------------------------------
// Macro management
// ---------------------------------------------------------------------------

function getMacroCommand() {
  return `(async () => {
  const mod = game.modules.get("${MODULE_ID}");
  const fn = mod?.api?.runOpposedTest;
  if (!fn) {
    ui.notifications.error(game.i18n.localize("${MODULE_ID}.error.apiUnavailable"));
    return;
  }
  await fn();
})();`;
}

async function ensureMacro() {
  if (!game.user.isGM) return;
  const macroName = loc("macro.name");
  const existing = game.macros.find(m => m.name === macroName);
  const command = getMacroCommand();
  if (!existing) {
    await MacroCls().create({
      name: macroName,
      type: MACRO_TYPE,
      img: "icons/skills/social/diplomacy-handshake.webp",
      command
    });
    ui.notifications.info(loc("macro.created", { name: macroName }));
    return;
  }
  const needsUpdate = existing.type !== MACRO_TYPE || existing.command !== command;
  if (needsUpdate) {
    await existing.update({ type: MACRO_TYPE, command });
    ui.notifications.info(loc("macro.updated", { name: macroName }));
  }
}

// ---------------------------------------------------------------------------
// Chat listener (GM action buttons only — roll requests now use sockets)
// ---------------------------------------------------------------------------

let listenerInstalled = false;

function installListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;

  Hooks.on("renderChatMessageHTML", (message, html, _context) => {
    const actionFlags = message.flags?.opposedAction;
    if (!actionFlags || !game.user.isGM) return;

    const buttons = html.querySelectorAll("[data-opp-action][data-opp-target]");
    if (!buttons || !buttons.length) return;

    buttons.forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.getAttribute("data-opp-action");
        const targetId = btn.getAttribute("data-opp-target");
        const token = canvas.tokens.get(targetId);
        if (!token || !token.actor) return;

        const slDiff = Number(actionFlags.slDiff ?? 0);
        const entangleAmount = Math.max(1, 1 + slDiff);

        if (action === "apply-entangled") {
          await applyStackedChange(token.actor, "entangled", entangleAmount);
          ui.notifications.info(loc("notify.entangledApply", { amount: entangleAmount, name: token.name }));
          return;
        }

        if (action === "remove-entangled") {
          await removeStackedChange(token.actor, "entangled", entangleAmount);
          ui.notifications.info(loc("notify.entangledRemove", { amount: entangleAmount, name: token.name }));
          return;
        }

        if (action === "grapple-damage") {
          const winnerToken = canvas.tokens.get(actionFlags.winnerId);
          const sb = getSB(winnerToken?.actor);
          const tb = getTB(token.actor);
          const rawDmg = sb + slDiff;
          const woundLoss = Math.max(0, rawDmg - tb);

          if (woundLoss > 0) {
            const before = Number(token.actor.system.status.wounds.value);
            const newWounds = Math.max(0, before - woundLoss);
            if (Number.isFinite(newWounds) && newWounds !== before) {
              await token.actor.update({ "system.status.wounds.value": newWounds });
            }
          }

          await ChatMessageCls().create({
            speaker: ChatMessageCls().getSpeaker(),
            content:
              `<div><strong>${loc("chat.grappleDamageResult", { wounds: woundLoss, name: esc(token.name) })}</strong>` +
              `<br><small>${loc("chat.grappleDamageBreakdown", { sb, slDiff, tb })}</small></div>`
          });

          if (game.combat && winnerToken?.actor) {
            const adv = Number(winnerToken.actor.system?.status?.advantage?.value ?? 0);
            await winnerToken.actor.update({ "system.status.advantage.value": adv + 1 });
          }
          return;
        }

        if (action === "grapple-entangle") {
          await applyStackedChange(token.actor, "entangled", 1);
          ui.notifications.info(loc("notify.entangledApplyOne", { name: token.name }));
          return;
        }

        if (action === "grapple-remove") {
          await removeStackedChange(token.actor, "entangled", entangleAmount);
          ui.notifications.info(loc("notify.entangledRemove", { amount: entangleAmount, name: token.name }));
        }
      });
    });
  });

  console.log(`${MODULE_ID} | Chat listener ready.`);
}

// ---------------------------------------------------------------------------
// Characteristic / skill option lists
// ---------------------------------------------------------------------------

const CHAR_LIST = [
  { key: "ws", locKey: "char.ws" },
  { key: "bs", locKey: "char.bs" },
  { key: "s",  locKey: "char.s" },
  { key: "t",  locKey: "char.t" },
  { key: "i",  locKey: "char.i" },
  { key: "ag", locKey: "char.ag" },
  { key: "dex", locKey: "char.dex" },
  { key: "int", locKey: "char.int" },
  { key: "wp", locKey: "char.wp" },
  { key: "fel", locKey: "char.fel" }
];

// ---------------------------------------------------------------------------
// Main opposed test workflow
// ---------------------------------------------------------------------------

/**
 * Run an opposed test between two or more selected tokens.
 *
 * The GM selects tokens, picks characteristics or skills for each, and
 * each participant rolls using the **native WFRP4e roll dialog** with full
 * access to modifiers, difficulty, and talent bonuses.
 *
 * - GM-controlled tokens: dialog opens on the GM's screen.
 * - Player-controlled tokens: a socket message triggers the dialog on
 *   the owning player's screen; results are sent back via socket.
 *
 * Rolls are performed sequentially (one dialog at a time) to avoid
 * overlapping dialog windows.
 *
 * @returns {Promise<void>}
 */
async function runOpposedTest() {
  const controlled = canvas.tokens.controlled;
  if (controlled.length < 2) {
    ui.notifications.warn(loc("error.selectTokens"));
    return;
  }

  const participants = controlled.map(t => ({ token: t, actor: t.actor })).filter(p => p.actor);
  if (participants.length < 2) {
    ui.notifications.warn(loc("error.actorsRequired"));
    return;
  }

  // Build localized characteristic list
  const charList = CHAR_LIST.map(c => ({ key: c.key, label: loc(c.locKey) }));

  // Build combined skill list
  const buildAllSkills = () => {
    const cfg = game.wfrp4e?.config?.skills || {};
    const set = new Set(Object.values(cfg));
    participants.forEach(p => {
      (p.actor?.items || []).filter(i => i.type === "skill").forEach(i => set.add(i.name));
    });
    return Array.from(set).sort();
  };

  const allSkills = buildAllSkills();
  const skillOptions = allSkills.map(s => ({ key: s, label: s }));

  const optionHtml = (arr, valueKey, labelKey) =>
    arr.map(o => `<option value="${esc(o[valueKey])}">${esc(o[labelKey])}</option>`).join("");

  const charOptionsHtml = optionHtml(charList, "key", "label");
  const skillOptionsHtml = optionHtml(skillOptions, "key", "label");
  const optionSets = { char: charOptionsHtml, skill: skillOptionsHtml };

  // Build difficulty options from the WFRP4e system config
  const difficultyLabels = game.wfrp4e?.config?.difficultyLabels || {};
  const difficultyOptionsHtml = Object.entries(difficultyLabels)
    .map(([key, label]) => `<option value="${esc(key)}"${key === "challenging" ? " selected" : ""}>${esc(label)}</option>`)
    .join("");

  let formInner = "";
  participants.forEach((p, idx) => {
    formInner +=
      `<fieldset style="margin-bottom:8px; padding:6px;">
        <legend>${esc(p.token.name)}</legend>
        <label>${loc("dialog.type")}
          <input type="radio" name="mode_${idx}" value="char" checked> ${loc("dialog.typeChar")}
          <input type="radio" name="mode_${idx}" value="skill" style="margin-left:8px;"> ${loc("dialog.typeSkill")}
        </label>
        <label style="display:block; margin-top:6px;">${loc("dialog.selection")}
          <select name="pick_${idx}">
            ${charOptionsHtml}
          </select>
        </label>
        <div style="display:flex; gap:8px; margin-top:6px;">
          <label style="flex:1;">${loc("dialog.difficulty")}
            <select name="difficulty_${idx}" style="width:100%;">
              ${difficultyOptionsHtml}
            </select>
          </label>
          <label style="flex:0 0 80px;">${loc("dialog.modifier")}
            <input type="number" name="modifier_${idx}" value="0" style="width:100%;">
          </label>
        </div>
      </fieldset>`;
  });

  formInner +=
    `<fieldset style="margin-bottom:8px; padding:6px;">
      <legend>${loc("dialog.testType")}</legend>
      <label><input type="checkbox" name="isGrapple"> ${loc("dialog.grapple")}</label>
      <label style="margin-left:8px;"><input type="checkbox" name="isEntangle"> ${loc("dialog.entangle")}</label>
    </fieldset>`;

  const content = `<div style="max-height:70vh; overflow:auto; padding:8px 6px 6px 6px;">${formInner}</div>`;

  const bindModeToggles = (root) => {
    const form = root?.querySelector?.("form");
    if (!form) return;
    const rebuild = (idx) => {
      const sel = form.querySelector(`select[name="pick_${idx}"]`);
      if (!sel) return;
      const mode = form.querySelector(`input[name="mode_${idx}"]:checked`)?.value || "char";
      const prev = sel.value;
      sel.innerHTML = optionSets[mode] || optionSets.char;
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    };
    const radios = [...form.querySelectorAll(`input[type="radio"][name^="mode_"]`)];
    const idxs = [...new Set(radios.map(r => r.name.split("_")[1]))];
    idxs.forEach(rebuild);
    radios.forEach(r => {
      r.addEventListener("change", () => rebuild(r.name.split("_")[1]));
    });
  };

  let formData;
  try {
    formData = await foundry.applications.api.DialogV2.wait({
      window: { title: loc("dialog.title") },
      content,
      render: (event, dialog) => {
        const root = dialog.element;
        bindModeToggles(root);
      },
      buttons: [
        {
          action: "roll",
          label: loc("dialog.roll"),
          default: true,
          callback: (event, button) => {
            const form = button.form;
            if (!form) return null;
            const picks = participants.map((_, idx) => ({
              mode: form.querySelector(`input[name="mode_${idx}"]:checked`)?.value,
              pick: form.querySelector(`select[name="pick_${idx}"]`)?.value,
              difficulty: form.querySelector(`select[name="difficulty_${idx}"]`)?.value || "challenging",
              modifier: Number(form.querySelector(`input[name="modifier_${idx}"]`)?.value) || 0
            }));
            return {
              picks,
              isGrapple: form.querySelector(`input[name="isGrapple"]`)?.checked || false,
              isEntangle: form.querySelector(`input[name="isEntangle"]`)?.checked || false
            };
          }
        },
        {
          action: "cancel",
          label: loc("dialog.cancel"),
          callback: () => null
        }
      ]
    });
  } catch {
    return;
  }

  if (!formData) return;

  if (formData.isGrapple && participants.length !== 2) {
    ui.notifications.error(loc("error.grappleTwoOnly"));
    return;
  }

  const labelForPick = (pick) => {
    if (pick.mode === "char") {
      const c = charList.find(x => x.key === pick.pick);
      return c ? c.label : (pick.pick || "").toUpperCase();
    }
    return pick.pick || loc("dialog.typeSkill");
  };

  // --- Announce NPC/Creature tests publicly ---
  const hasNpcOrCreature = participants.some(p => ["npc", "creature"].includes(p.actor?.type));
  if (hasNpcOrCreature) {
    const firstPick = formData.picks[0];
    const title = loc("chat.opposedPre", { test: labelForPick(firstPick) });
    const lines = participants
      .map((p, idx) => `${esc(p.token.name)}: ${esc(labelForPick(formData.picks[idx]))}`)
      .join("<br>");
    await ChatMessageCls().create({
      speaker: ChatMessageCls().getSpeaker(),
      content: `<div class="opposed-pre"><strong>${esc(title)}</strong><br>${lines}</div>`
    });
  }

  // --- Perform rolls sequentially using native WFRP4e dialog ---
  const results = [];
  for (let idx = 0; idx < participants.length; idx++) {
    const p = participants[idx];
    const pick = formData.picks[idx];
    const label = `${p.token.name} - ${labelForPick(pick)}`;

    let rollResult;
    try {
      rollResult = await rollForParticipant(p.actor, pick.mode, pick.pick, label, {
        difficulty: pick.difficulty,
        modifier: pick.modifier
      });
    } catch (err) {
      console.error(`${MODULE_ID} | Roll error for ${p.token.name}:`, err);
      ui.notifications.error(loc("error.timeout", { label }));
      return;
    }

    if (!rollResult) {
      // Roll was cancelled — abort the opposed test
      ui.notifications.warn(loc("error.rollCancelled", { name: p.token.name }));
      return;
    }

    results.push({
      idx,
      token: p.token,
      actor: p.actor,
      testLabel: labelForPick(pick),
      targetValue: rollResult.target,
      rollTotal: rollResult.roll,
      sl: rollResult.sl,
      succeeded: rollResult.succeeded
    });
  }

  // --- Determine winner/loser ---
  const sorted = [...results].sort((a, b) => (b.sl !== a.sl) ? (b.sl - a.sl) : (b.targetValue - a.targetValue));
  let winner = sorted[0];
  if (sorted.length > 1) {
    const top = sorted[0];
    const second = sorted[1];
    if (top.sl === second.sl && top.targetValue === second.targetValue) winner = null;
  }

  const sortedLow = [...results].sort((a, b) => (a.sl !== b.sl) ? (a.sl - b.sl) : (a.targetValue - b.targetValue));
  let loser = sortedLow[0];
  if (sortedLow.length > 1) {
    const low = sortedLow[0];
    const second = sortedLow[1];
    if (low.sl === second.sl && low.targetValue === second.targetValue) loser = null;
  }

  // --- Build result messages ---
  const slDiff = (winner && loser) ? (winner.sl - loser.sl) : 0;
  const gmIds = game.users.filter(u => u.isGM).map(u => u.id);

  // Determine the test name from the first pick (they're usually the same test)
  const testLabel = labelForPick(formData.picks[0]);

  // Format SL with +/- sign
  const formatSL = (sl) => (sl >= 0 ? `+${sl}` : `${sl}`);

  // GM action buttons
  const actionButtons = formData.isEntangle ? participants.map((p) =>
    `<div style="margin:4px 0;"><strong>${esc(p.token.name)}</strong><br>` +
    `<button type="button" data-opp-action="apply-entangled" data-opp-target="${p.token.id}">${loc("chat.applyEntangled")}</button>` +
    `<button type="button" data-opp-action="remove-entangled" data-opp-target="${p.token.id}">${loc("chat.removeEntangled")}</button></div>`
  ).join("") : "";

  const grappleButtons = (formData.isGrapple && winner && loser)
    ? `<div style="margin-top:6px;"><strong>${loc("chat.grappleChoices")}</strong><br>` +
      `<button type="button" data-opp-action="grapple-damage" data-opp-target="${loser.token.id}">${loc("chat.grappleDamage", { name: esc(loser.token.name) })}</button>` +
      `<button type="button" data-opp-action="grapple-entangle" data-opp-target="${loser.token.id}">${loc("chat.grappleEntangle", { name: esc(loser.token.name) })}</button>` +
      `<button type="button" data-opp-action="grapple-remove" data-opp-target="${winner.token.id}">${loc("chat.grappleRemove", { name: esc(winner.token.name) })}</button></div>`
    : "";

  // Winner line — name large and centered, test description below
  const winnerLine = winner
    ? `<div style="text-align:center;"><strong style="font-size:1.3em;">${esc(winner.token.name)}</strong><br>${loc("chat.winsOpposed", { test: esc(testLabel) })}</div>`
    : `<div style="text-align:center;"><strong style="font-size:1.3em;">${loc("chat.noWinner")}</strong><br>${loc("chat.draw")}</div>`;

  // Adjusted SL line
  const adjustedSlLine = (winner && loser)
    ? `${loc("chat.adjustedSL")}: <strong>${formatSL(slDiff)}</strong>`
    : "";

  // Individual roll lines
  const rollLines = results
    .map(r => loc("chat.rollDetail", {
      name: esc(r.token.name),
      target: r.targetValue,
      roll: r.rollTotal,
      sl: formatSL(r.sl)
    }))
    .join("<br>");

  const publicSummary =
    `<div class="opposed-summary">` +
    `${winnerLine}` +
    `${adjustedSlLine ? `<p>${adjustedSlLine}</p>` : ""}` +
    `<p style="margin-top:6px;"><strong>${loc("chat.individualResults")}:</strong><br>${rollLines}</p>` +
    `</div>`;

  const gmSummary =
    `<div class="opposed-summary">` +
    `${winnerLine}` +
    `${adjustedSlLine ? `<p>${adjustedSlLine}</p>` : ""}` +
    `<p style="margin-top:6px;"><strong>${loc("chat.individualResults")}:</strong><br>${rollLines}</p>` +
    `${(formData.isGrapple || formData.isEntangle) ? `<hr><strong>${loc("chat.gmActions")}</strong><br>` : ""}` +
    `${actionButtons}${grappleButtons}</div>`;

  await ChatMessageCls().create({
    speaker: ChatMessageCls().getSpeaker(),
    content: publicSummary
  });

  await ChatMessageCls().create({
    speaker: ChatMessageCls().getSpeaker(),
    content: gmSummary,
    whisper: gmIds,
    flags: {
      opposedAction: {
        participants: participants.map(p => p.token.id),
        winnerId: winner ? winner.token.id : null,
        loserId: loser ? loser.token.id : null,
        slDiff,
        winnerRoll: winner ? winner.rollTotal : null,
        winnerSL: winner ? winner.sl : null
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Module initialization
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    mod.api = { runOpposedTest };
  }
});

Hooks.once("ready", async () => {
  // Register socket listener (all clients — GM and players)
  game.socket.on(SOCKET_ID, handleSocketMessage);

  installListener();
  await ensureMacro();
});
