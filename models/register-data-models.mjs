import { RitualData } from "./actor/ritual-data.mjs";
import { SurvivorData } from "./actor/survivor-data.mjs";
import { ThemData } from "./actor/them-data.mjs";
import { BrinkData } from "./item/brink-data.mjs";
import { MomentData } from "./item/moment-data.mjs";
import { TraitData } from "./item/trait-data.mjs";
import { ModuleData } from "./item/module-data.mjs";

export function registerDataModels() {
  // Register during init, before world documents are constructed. Type names
  // must match system.json; "session" deliberately uses Actor persistence for
  // shared game state rather than representing another character.
  Object.assign(CONFIG.Actor.dataModels, {
    session: RitualData,
    survivor: SurvivorData,
    them: ThemData
  });

  Object.assign(CONFIG.Item.dataModels, {
    trait: TraitData,
    moment: MomentData,
    brink: BrinkData,
    module: ModuleData
  });

  Object.assign(CONFIG.Actor.typeLabels, {
    session: "TENCANDLES.Actor.Session",
    survivor: "TENCANDLES.Actor.Survivor",
    them: "TENCANDLES.Actor.Them"
  });

  Object.assign(CONFIG.Item.typeLabels, {
    trait: "TENCANDLES.Item.Trait",
    moment: "TENCANDLES.Item.Moment",
    brink: "TENCANDLES.Item.Brink",
    module: "TENCANDLES.Item.Module"
  });
}
