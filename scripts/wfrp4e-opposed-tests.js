// WFRP4e Opposed Tests module for Foundry VTT v13
// GM macro + chat listener/action handlers for opposed tests,
// including Grapple and Entangled special-case resolution.

const MODULE_ID = "wfrp4e-opposed-tests";
const MACRO_TYPE = "script";
const ROLL_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Localization helper
// ---------------------------------------------------------------------------

/**
 * Shorthand for game.i18n.localize / game.i18n.format.
 * @param {string} key  - Translation key (without module prefix).
 * @param {object} [data] - Interpolation data for game.i18n.format.
 * @returns {string}
 */
function loc(key, data) {
  const fullKey = key.startsWith(MODULE_ID) ? key : `${MODULE_ID}.${key}`;
  return data ? game.i18n.format(fullKey, data) : game.i18n.localize(fullKey);
}

// ---------------------------------------------------------------------------
// HTML-escape helper (XSS safety for interpolated names)
// ---------------------------------------------------------------------------

function esc(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Characteristic helpers
// ---------------------------------------------------------------------------

/** Return the Strength Bonus for an actor. */
function getSB(actor) {
  const c = actor?.system?.characteristics?.s;
  const bonusRaw = c && (c.bonus ?? c.b);
  const bonus = Number(bonusRaw);
  if (Number.isFinite(bonus)) return bonus;
  const val = Number(c && (c.value ?? c.total));
  if (Number.isFinite(val)) return Math.floor(val / 10);
  return 0;
}

/** Return the Toughness Bonus for an actor. */
function getTB(actor) {
  const c = actor?.system?.characteristics?.t;
  const bonusRaw = c && (c.bonus ?? c.b);
  const bonus = Number(bonusRaw);
  if (Number.isFinite(bonus)) return bonus;
  const val = Number(c && (c.value ?? c.total));
  if (Number.isFinite(val)) return Math.floor(val / 10);
  return 0;
}

/** Return the total value of a characteristic by key. */
function getCharacteristicValue(actor, key) {
  const c = actor?.system?.characteristics?.[key];
  return Number(c && (c.value ?? c.total ?? c) || 0);
}

/**
 * Given a skill name, return the characteristic key it is based on.
 * Uses the WFRP4e system config maps.
 */
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

/** Look up a skill's total value on an actor, falling back to raw characteristic. */
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

/** Return the first active player who owns this actor, or null. */
function getActiveOwner(actor) {
  const owners = game.users.players.filter(u => u.active && actor.testUserPermission(u, "OWNER"));
  return owners[0] ?? null;
}

/** Calculate Success Levels (SL) per WFRP4e rules. */
function calcSL(rollTotal, target) {
  return Math.floor(target / 10) - Math.floor(rollTotal / 10);
}

// ---------------------------------------------------------------------------
// Hit location resolver
// ---------------------------------------------------------------------------

function resolveHitLocKey(rollTotal, defenderActor) {
  const hitLoc = game.wfrp4e?.utility?.getHitLoc?.(rollTotal);
  let key = null;
  if (typeof hitLoc === "string") key = hitLoc;
  else if (hitLoc && typeof hitLoc === "object") key = hitLoc.value ?? hitLoc.key ?? hitLoc.id ?? hitLoc.name;

  const armour = defenderActor?.status?.armour;
  if (key && armour && armour[key]) return key;
  if (armour?.body) return "body";
  const keys = armour ? Object.keys(armour) : [];
  return keys[0] || "body";
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
      if (typeof actor.addCondition === "function") {
        await actor.addCondition(key);
      }
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
// Roll delegation helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a chat message containing the roll result for a given request ID.
 * @param {string} requestId
 * @param {string} label
 * @returns {Promise<{total: number}>}
 */
function waitForResult(requestId, label) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      Hooks.off("createChatMessage", handler);
      reject(new Error(loc("error.timeout", { label })));
    }, ROLL_TIMEOUT_MS);

    const handler = (msg) => {
      const data = msg.flags?.tanglefoot;
      if (!data || data.requestId !== requestId) return;
      clearTimeout(timeoutId);
      Hooks.off("createChatMessage", handler);
      resolve({ total: data.total ?? msg.rolls?.[0]?.total });
    };

    Hooks.on("createChatMessage", handler);
  });
}

/**
 * Request a d100 roll from a player (or roll locally for the GM).
 * If the actor's owner is another player, a whispered roll-request card is sent
 * and we await their response via the chat listener.
 */
async function requestRoll(owner, actor, label, targetValue) {
  if (!owner || owner.id === game.user.id) {
    const roll = await new Roll("1d100").evaluate();
    await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `${esc(label)} (${loc("chat.target", { value: targetValue })})`,
      flags: { tanglefoot: { requestId: "local-" + foundry.utils.randomID(), total: roll.total } }
    });
    return { total: roll.total };
  }

  const requestId = foundry.utils.randomID();
  const card =
    `<div class="tanglefoot-roll-request">` +
    `<p><strong>${esc(label)}</strong></p>` +
    `<p>${loc("chat.target", { value: targetValue })}</p>` +
    `<button type="button" data-tanglefoot-roll="${requestId}">${loc("chat.rollButton")}</button>` +
    `</div>`;

  await ChatMessage.create({
    content: card,
    speaker: ChatMessage.getSpeaker({ actor }),
    whisper: [owner.id],
    flags: { tanglefoot: { requestId, actorId: actor.id, label, targetValue } }
  });

  return await waitForResult(requestId, label);
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
    await Macro.create({
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
// Chat listener (hooks into rendered chat cards)
// ---------------------------------------------------------------------------

let listenerInstalled = false;

function installListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;

  // v13: use renderChatMessageHTML — html arg is an HTMLElement, not jQuery
  Hooks.on("renderChatMessageHTML", (message, html, _context) => {

    // --- Player roll-request button handling ---
    const rollReq = message.flags?.tanglefoot;
    if (rollReq) {
      if (!message.whisper || !message.whisper.includes(game.user.id)) return;
      const btn = html.querySelector(`[data-tanglefoot-roll="${rollReq.requestId}"]`);
      if (!btn) return;

      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const actor = game.actors.get(rollReq.actorId);
        if (!actor) return;

        const roll = await new Roll("1d100").evaluate();
        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: `${esc(rollReq.label)} (${loc("chat.target", { value: rollReq.targetValue })})`,
          flags: {
            tanglefoot: {
              requestId: rollReq.requestId,
              total: roll.total
            }
          }
        });
      });
      return;
    }

    // --- GM action buttons (entangle / grapple) ---
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
          const dmg = Math.max(0, Number(getSB(winnerToken?.actor)) + slDiff);
          const hitRoll = Number(actionFlags.winnerRoll ?? 0);
          const hitLocKey = resolveHitLocKey(hitRoll, token.actor);
          let damageApplied = false;
          let woundLoss = dmg;

          try {
            if (typeof token.actor.applyDamage === "function") {
              const dmgType = game.wfrp4e?.config?.DAMAGE_TYPE?.IGNORE_AP;
              const opposedTest = {
                attacker: winnerToken ? winnerToken.actor : null,
                attackerTest: {
                  result: { roll: hitRoll, critical: false },
                  damageEffects: [],
                  item: {
                    properties: { qualities: {}, flaws: {} },
                    Qualities: [],
                    Flaws: [],
                    runScripts: () => []
                  },
                  weapon: {
                    attackType: "melee",
                    properties: { qualities: {}, flaws: {} },
                    Qualities: [],
                    Flaws: []
                  }
                },
                defenderTest: { context: { unopposed: false }, failed: true, weapon: null },
                result: { damage: { value: dmg }, hitloc: { value: hitLocKey }, damaging: false }
              };
              if (dmgType !== undefined) {
                await token.actor.applyDamage(opposedTest, dmgType);
                damageApplied = true;
              }
            }
          } catch (e) {
            console.warn(`${MODULE_ID} | applyDamage failed, falling back to manual:`, e);
          }

          // Fallback: manual wound calculation only if applyDamage was not used
          if (!damageApplied) {
            const before = token.actor.system.status.wounds.value;
            const tb = getTB(token.actor);
            woundLoss = Math.max(0, dmg - tb);
            const newWounds = Math.max(0, before - woundLoss);
            if (newWounds !== before) {
              await token.actor.update({ "system.status.wounds.value": newWounds });
            }
          }

          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker(),
            content: `<div><strong>${loc("chat.grappleDamageResult", { wounds: woundLoss, name: esc(token.name) })}</strong></div>`
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
 * The GM selects tokens on the canvas, runs the macro, then picks
 * characteristics or skills for each participant. The module handles
 * rolling (delegating to players when appropriate), SL comparison,
 * and grapple/entangle action buttons on the GM-whispered result card.
 *
 * Requires at least 2 tokens selected. Grapple tests require exactly 2.
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

  // Build combined skill list from system config + participant inventories
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

  // Store option sets in a closure-scoped map (avoids fragile data-attribute escaping)
  const optionSets = { char: charOptionsHtml, skill: skillOptionsHtml };

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
        // v13: dialog is the DialogV2 instance; dialog.element is the HTMLElement
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
              pick: form.querySelector(`select[name="pick_${idx}"]`)?.value
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

  // --- Label helper ---
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
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker(),
      content: `<div class="opposed-pre"><strong>${esc(title)}</strong><br>${lines}</div>`
    });
  }

  // --- Perform rolls ---
  const results = [];
  try {
    const rollPromises = participants.map((p, idx) => {
      const pick = formData.picks[idx];
      let target;

      if (pick.mode === "char") {
        target = getCharacteristicValue(p.actor, pick.pick);
      } else {
        target = getSkillValue(p.actor, pick.pick);
        if (!Number.isFinite(target)) {
          const fallbackChar = inferSkillCharacteristic(pick.pick);
          if (fallbackChar) target = getCharacteristicValue(p.actor, fallbackChar);
          else {
            ui.notifications.warn(loc("error.noSkill", { skill: pick.pick, name: p.token.name }));
            target = 0;
          }
        }
      }

      const owner = getActiveOwner(p.actor);
      const label = `${p.token.name} - ${labelForPick(pick)}`;

      return requestRoll(owner, p.actor, label, target).then(r => ({
        idx,
        token: p.token,
        actor: p.actor,
        targetValue: target,
        rollTotal: r.total
      }));
    });

    const settled = await Promise.all(rollPromises);
    results.push(...settled);
  } catch (err) {
    console.error(`${MODULE_ID} | Roll error:`, err);
    return;
  }

  // --- Calculate SL and determine winner/loser ---
  results.forEach(r => { r.sl = calcSL(r.rollTotal, r.targetValue); });

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
  const winnerName = winner ? esc(winner.token.name) : loc("chat.noWinner");
  const summaryLines = results
    .map(r => `${esc(r.token.name)}: ${loc("chat.sl", { value: r.sl, target: r.targetValue })}`)
    .join("<br>");
  const gmIds = game.users.filter(u => u.isGM).map(u => u.id);

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

  const publicSummary =
    `<div class="opposed-summary">` +
    `<strong>${loc("chat.opposedResult")}</strong><br>` +
    `<strong>${loc("chat.winner")}</strong> ${winnerName} (${loc("chat.slDiff", { value: slDiff })})<br>` +
    `<strong>${loc("chat.results")}</strong><br>${summaryLines}<br></div>`;

  const gmSummary =
    `<div class="opposed-summary">` +
    `<strong>${loc("chat.opposedResult")}</strong><br>` +
    `<strong>${loc("chat.winner")}</strong> ${winnerName} (${loc("chat.slDiff", { value: slDiff })})<br>` +
    `<strong>${loc("chat.results")}</strong><br>${summaryLines}<br>` +
    `${(formData.isGrapple || formData.isEntangle) ? `<hr><strong>${loc("chat.gmActions")}</strong><br>` : ""}` +
    `${actionButtons}${grappleButtons}</div>`;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: publicSummary
  });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
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
  installListener();
  await ensureMacro();
});
