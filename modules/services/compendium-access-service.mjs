import { SYSTEM_ID } from "../constants.mjs";

export function normalizeAnswer(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Compare normalized answer digests without embedding the answers in code.
// This is a client-side access gate, not encryption of the shipped pack data.
const challenges = {
  fr: "e63705bf04f0762779aa9398e433ef72f44cff846c46ac6ad07f8056d74f415e",
  en: "cc19d9ea1d834967df2f3769b2617873375edfe6d81ea3de1ed0a5e6d14ce0e1"
};
const guarded = new WeakSet();
const indexes = new WeakMap();
const validating = new Set();

export function canAccessModules(language) {
  return game.settings.get(SYSTEM_ID, `modulesUnlocked${language}`) === true;
}

export async function validateModuleAnswers(language) {
  if (!game.user?.isGM || validating.has(language)) return;
  const keys = [1, 2, 3].map(number => `modulesWord${language}${number}`);
  const answers = keys.map(key => normalizeAnswer(game.settings.get(SYSTEM_ID, key)));
  if (answers.some(answer => !answer)) return;
  validating.add(language);
  try {
    const input = `ten-candles-modules-${language}-v1|${answers.join("|")}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const valid = hash === challenges[language];
    if (valid) await game.settings.set(SYSTEM_ID, `modulesUnlocked${language}`, true);
    for (const key of keys) await game.settings.set(SYSTEM_ID, key, "");
    ui.notifications[valid ? "info" : "warn"](game.i18n.localize(`TENCANDLES.CompendiumAccess.${valid ? "Success" : "Failure"}`));
  } finally {
    validating.delete(language);
  }
}

export function updateModuleProtection() {
  const hidden = [];
  for (const language of Object.keys(challenges)) {
    const pack = game.packs.get(`${SYSTEM_ID}.modules-${language}`);
    if (!pack) continue;
    if (!guarded.has(pack)) {
      // Protect programmatic reads as well as directory visibility. WeakSet
      // prevents nesting wrappers each time Foundry renders the directory.
      for (const method of ["getDocument", "getDocuments", "getIndex"]) {
        const original = pack[method];
        if (typeof original !== "function") continue;
        pack[method] = async function (...args) {
          if (!canAccessModules(language)) return method === "getDocument" ? undefined : [];
          return original.apply(this, args);
        };
      }
      guarded.add(pack);
    }
    if (!canAccessModules(language)) {
      hidden.push(pack.collection);
      if (pack.index?.size) {
        indexes.set(pack, pack.index.contents.map(entry => foundry.utils.deepClone(entry)));
        pack.index.clear();
      }
      for (const app of Object.values(pack.apps ?? {})) void app.close();
      pack.clear?.();
    } else if (pack.index?.size === 0) {
      for (const entry of indexes.get(pack) ?? []) pack.index.set(entry._id, entry);
    }
  }
  let style = document.getElementById("ten-candles-protected-packs");
  if (!style) {
    style = document.createElement("style");
    style.id = "ten-candles-protected-packs";
    document.head.append(style);
  }
  style.textContent = hidden.map(collection => `.directory-item[data-pack="${collection}"] { display: none !important; }`).join("\n");
}

export function registerModuleAccessSettings() {
  for (const language of Object.keys(challenges)) {
    game.settings.register(SYSTEM_ID, `modulesUnlocked${language}`, {
      scope: "world", config: false, type: Boolean, default: false,
      onChange: () => { updateModuleProtection(); ui.compendium?.render?.(true); }
    });
    for (const number of [1, 2, 3]) {
      game.settings.register(SYSTEM_ID, `modulesWord${language}${number}`, {
        name: `TENCANDLES.CompendiumAccess.${language}.Word${number}`,
        hint: `TENCANDLES.CompendiumAccess.${language}.Hint${number}`,
        scope: "client", config: language === "en" || game.i18n.lang === "fr", restricted: true, type: String, default: "",
        onChange: () => validateModuleAnswers(language)
      });
    }
  }
}
