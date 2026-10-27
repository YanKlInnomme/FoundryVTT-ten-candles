export class ConflictRollService {
  // Resolve real Foundry Rolls outside the plain-data rule engine. UI requests
  // may already contain the acting user's results; prepare fills in missing
  // rolls on the authority path, while tests can inject deterministic arrays.
  static async prepare(command, ritual) {
    if (!command.name.startsWith("conflict.")) return;
    const conflict = ritual.system.conflict;
    if (command.name === "conflict.rollPlayer" && !command.payload.rolls) {
      const hopeDiceCount = command.payload.useHopeDice ? conflict.availableHopeDiceCount : 0;
      command.payload.hopeDiceCount = hopeDiceCount;
      command.payload.rolls = {
        player: await this.#roll(conflict.commonDiceCount),
        hope: await this.#roll(hopeDiceCount)
      };
    }
    if (command.name === "conflict.rollGm" && !command.payload.rolls) {
      command.payload.rolls = { gm: await this.#roll(conflict.gmDiceCount) };
    }
    if (command.name === "conflict.burnTrait" && !command.payload.rerolls) {
      command.payload.rerolls = await this.#roll(conflict.playerResults.filter((result) => result === 1).length);
    }
    if (command.name === "conflict.embraceBrink" && !command.payload.rolls) {
      command.payload.rolls = {
        player: await this.#roll(conflict.commonDiceCount),
        hope: await this.#roll(conflict.hopeDiceCount)
      };
    }
    if (command.name === "conflict.useThemBrink" && !command.payload.rerolls) command.payload.rerolls = await this.#roll(conflict.gmDiceCount);
  }

  static async rollForCurrentUser(count) {
    if (!count) return [];
    const roll = await new Roll(`${count}d6`).evaluate();
    this.#showDice(roll);
    return this.#results(roll);
  }

  static #showDice(roll) {
    if (!game.modules.get("dice-so-nice")?.active || !game.dice3d?.showForRoll) return;

    try {
      // Dice So Nice is presentation only: starting or queueing its animation
      // must not delay the conflict state, the next roll, or the result display.
      void game.dice3d.showForRoll(roll, game.user, true).catch((error) => {
        console.warn("Ten Candles | Dice So Nice animation could not start.", error);
      });
    } catch (error) {
      console.warn("Ten Candles | Dice So Nice animation could not start.", error);
    }
  }

  static async #roll(count) {
    if (!count) return [];
    const roll = await new Roll(`${count}d6`).evaluate();
    return this.#results(roll);
  }

  static #results(roll) { return roll.dice.flatMap((die) => die.results.filter((result) => result.active).map((result) => result.result)); }
}
