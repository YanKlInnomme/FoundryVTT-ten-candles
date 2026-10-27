import { SYSTEM_ID } from "./constants.mjs";

export function addTenCandlesLinksToSettings(_app, html) {
  const settingsRoot = html instanceof HTMLElement ? html : html?.[0];
  if (!settingsRoot || settingsRoot.querySelector("[data-ten-candles-settings-links]")) return;
  const gameSettingsHeader = settingsRoot.querySelector("h4.divider");
  if (!gameSettingsHeader) return;

  const logoFiles = game.i18n.lang === "fr"
    ? { light: "logo-fr.webp", dark: "logo-dark-fr.webp" }
    : { light: "logo.webp", dark: "logo-dark.webp" };
  const getTheme = () => {
    const themeHost = settingsRoot.closest(".theme-dark, .theme-light") ?? document.documentElement;
    if (themeHost.classList.contains("theme-dark")) return "dark";
    if (themeHost.classList.contains("theme-light")) return "light";
    return game.settings.get("core", "uiConfig")?.colorScheme?.interface ?? "light";
  };
  const getLogoPath = () => `systems/${SYSTEM_ID}/assets/${logoFiles[getTheme()] ?? logoFiles.light}`;

  const section = document.createElement("section");
  section.classList.add("settings", "flexcol");
  section.dataset.tenCandlesSettingsLinks = "";
  const heading = document.createElement("h4");
  heading.classList.add("divider");
  heading.textContent = game.i18n.localize("WORLD.FIELDS.system.label");
  const badge = document.createElement("div");
  badge.classList.add("ten-candles", "system-badge");
  const logo = document.createElement("img");
  logo.classList.add("dynamic-logo");
  logo.src = getLogoPath();
  logo.alt = game.i18n.localize("TENCANDLES.Links.LogoAlt");
  badge.append(logo);
  section.append(heading, badge);

  const links = [
    { icon: "fa-solid fa-cart-shopping", key: "Shop" },
    { icon: "fab fa-github", key: "Git" },
    { icon: "fa-regular fa-mug-hot fa-bounce", key: "Donation" }
  ];
  for (const [index, { icon, key }] of links.entries()) {
    const linkSection = document.createElement("section");
    linkSection.classList.add("settings", "flexcol");
    const button = document.createElement("button");
    button.type = "button";
    const label = game.i18n.localize(`TENCANDLES.Links.${key}Title`);
    const url = game.i18n.localize(`TENCANDLES.Links.${key}URL`);
    button.innerHTML = `<i class="${icon}"></i>${label}<sup><i class="fa-light fa-up-right-from-square"></i></sup>`;
    if (index === links.length - 1) button.style.marginBottom = "1rem";
    button.addEventListener("click", (event) => {
      event.preventDefault();
      window.open(url, "_blank", "noopener,noreferrer");
    });
    linkSection.append(button);
    section.append(linkSection);
  }
  gameSettingsHeader.parentNode.insertBefore(section, gameSettingsHeader);

  const observer = new MutationObserver(() => {
    if (!section.isConnected) return observer.disconnect();
    const source = getLogoPath();
    if (logo.getAttribute("src") !== source) logo.setAttribute("src", source);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  if (settingsRoot !== document.documentElement) {
    observer.observe(settingsRoot, { attributes: true, attributeFilter: ["class"] });
  }
}

export function registerSettings() {
  // Accessibility preferences are per client and only toggle CSS. Debug mode is
  // world-scoped and checked again by command permissions, not just by the UI.
  const toggleClientClass = (className, enabled) => document.documentElement.classList.toggle(className, enabled);
  game.settings.register(SYSTEM_ID, "reduceMotion", {
    name: "TENCANDLES.Settings.ReduceMotion.Name",
    hint: "TENCANDLES.Settings.ReduceMotion.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: (enabled) => toggleClientClass("ten-candles-reduce-motion", enabled)
  });

  game.settings.register(SYSTEM_ID, "highLegibility", {
    name: "TENCANDLES.Settings.HighLegibility.Name",
    hint: "TENCANDLES.Settings.HighLegibility.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: (enabled) => toggleClientClass("ten-candles-high-legibility", enabled)
  });

  game.settings.register(SYSTEM_ID, "debugMode", {
    name: "TENCANDLES.Settings.DebugMode.Name",
    hint: "TENCANDLES.Settings.DebugMode.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true
  });
}
