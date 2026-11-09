import { app } from 'electron';
import { Flavour, Metadata, PlayerDeathType, RawCombatant } from 'main/types';
import Combatant from 'main/Combatant';
import { VideoCategory } from '../types/VideoCategory';
import Activity from './Activity';

/**
 * Outcome of a world PvP engagement. Decides whether the clip is kept and
 * how it is labelled.
 *
 * - Death: the player died while engaged with enemy players.
 * - Kill:  the player (or their pet) landed a killing blow on a player.
 * - Duel:  damage went both ways between the player and another player but
 *          nobody died. Duels never produce a UNIT_DIED / PARTY_KILL (the
 *          loser stops at 1 HP), so this is how they are detected. A world
 *          duel is confirmed when we saw the Duel spell cast between us and
 *          the opponent.
 * - Fight: as Duel, but no duel cast was seen, e.g. a world PvP fight both
 *          sides walked away from, or a duel accepted out of log range.
 */
export enum WorldPvPOutcome {
  Kill = 'Kill',
  Death = 'Death',
  Duel = 'Duel',
  Fight = 'Fight',
}

type Opponent = {
  name: string;
  dealtTo: boolean; // we damaged them
  takenFrom: boolean; // they damaged us
};

/**
 * Short clip of a world PvP engagement (kills, deaths and duels) outside of
 * any instanced activity. Currently only produced by the WoW Forever log
 * handler.
 */
export default class WorldPvP extends Activity {
  private opponents = new Map<string, Opponent>();

  private kills: PlayerDeathType[] = [];

  private playerDied = false;

  private duelOpponents = new Set<string>();

  private includeDuels: boolean;

  /**
   * Date of the last PvP combat event seen, used to trim the end of the clip.
   */
  public lastPvPDate: Date;

  constructor(startDate: Date, flavour: Flavour, includeDuels: boolean) {
    super(startDate, VideoCategory.WorldPvP, flavour);
    this.includeDuels = includeDuels;
    this.lastPvPDate = startDate;
  }

  /**
   * Record a damage (or miss) event between us and another player.
   */
  public onPvPDamage(
    date: Date,
    opponentGUID: string,
    opponentName: string,
    outgoing: boolean,
  ) {
    this.lastPvPDate = date;

    const opponent = this.opponents.get(opponentGUID) ?? {
      name: opponentName,
      dealtTo: false,
      takenFrom: false,
    };

    if (outgoing) opponent.dealtTo = true;
    else opponent.takenFrom = true;

    this.opponents.set(opponentGUID, opponent);
  }

  /**
   * Mark a player as a confirmed duel opponent (we saw the Duel cast).
   */
  public onDuelCast(opponentGUID: string) {
    this.duelOpponents.add(opponentGUID);
  }

  public onKill(date: Date, victimGUID: string, victimName: string) {
    this.lastPvPDate = date;

    if (!this.opponents.has(victimGUID)) {
      this.opponents.set(victimGUID, {
        name: victimName,
        dealtTo: true,
        takenFrom: false,
      });
    }

    const kill: PlayerDeathType = {
      name: victimName,
      specId: 0,
      date,
      timestamp: this.relativeSeconds(date),
      friendly: false, // Enemy death, shown as such on the timeline.
    };

    this.kills.push(kill);
    this.addDeath(kill);
  }

  public onPlayerDeath(date: Date, playerName: string) {
    this.lastPvPDate = date;
    this.playerDied = true;

    this.addDeath({
      name: playerName,
      specId: 0,
      date,
      timestamp: this.relativeSeconds(date),
      friendly: true,
    });
  }

  public get killCount() {
    return this.kills.length;
  }

  public get died() {
    return this.playerDied;
  }

  /**
   * True if damage has gone both ways between us and at least one player.
   */
  public hasMutualDamage() {
    return Array.from(this.opponents.values()).some(
      (o) => o.dealtTo && o.takenFrom,
    );
  }

  public get outcome(): WorldPvPOutcome | undefined {
    if (this.playerDied) return WorldPvPOutcome.Death;
    if (this.kills.length > 0) return WorldPvPOutcome.Kill;
    if (!this.includeDuels) return undefined;

    const mutual = Array.from(this.opponents.entries()).filter(
      ([, o]) => o.dealtTo && o.takenFrom,
    );

    if (mutual.some(([guid]) => this.duelOpponents.has(guid))) {
      return WorldPvPOutcome.Duel;
    }

    if (mutual.length > 0) return WorldPvPOutcome.Fight;
    return undefined;
  }

  /**
   * Nothing interesting happened (e.g. duels disabled and nobody died), so
   * don't keep the video.
   */
  shouldDiscard(): boolean {
    return this.outcome === undefined;
  }

  private relativeSeconds(date: Date) {
    // Back off 2 seconds so the timeline marker lands just before the event.
    const s = (date.getTime() - this.startDate.getTime()) / 1000 - 2;
    return Math.max(s, 0);
  }

  private opponentNames() {
    // Prefer listing whoever we actually traded damage with or killed.
    const killed = this.kills.map((k) => k.name);

    const others = Array.from(this.opponents.values())
      .filter((o) => !killed.includes(o.name))
      .sort(
        (a, b) =>
          Number(b.dealtTo && b.takenFrom) - Number(a.dealtTo && a.takenFrom),
      )
      .map((o) => o.name);

    return [...new Set([...killed, ...others])];
  }

  private describe() {
    const outcome = this.outcome ?? 'PvP';
    const names = this.opponentNames();
    let label: string = outcome;

    if (outcome === WorldPvPOutcome.Kill && this.kills.length > 1) {
      label = `${this.kills.length} Kills`;
    }

    if (names.length === 0) return label;
    const shown = names.slice(0, 3).join(', ');
    const extra = names.length > 3 ? ` +${names.length - 3}` : '';
    return `${label} - ${shown}${extra}`;
  }

  getMetadata(): Metadata {
    const combatants: RawCombatant[] = Array.from(
      this.combatantMap.values(),
    ).map((c: Combatant) => c.getRaw());

    let player: RawCombatant | undefined;

    if (this.playerGUID) {
      player = this.getCombatant(this.playerGUID)?.getRaw();
    }

    return {
      category: VideoCategory.WorldPvP,
      flavour: this.flavour,
      zoneID: this.zoneID,
      duration: this.duration,
      // "Result" is a win if we got a kill and survived, or won nothing else.
      result: this.kills.length > 0 && !this.playerDied,
      player,
      deaths: this.deaths,
      encounterName: this.describe(),
      overrun: this.overrun,
      combatants,
      start: this.startDate.getTime(),
      uniqueHash: this.getUniqueHash(),
      appVersion: app.getVersion(),
    };
  }

  getFileName(): string {
    // Strip characters Windows doesn't allow in file names.
    return `World PvP - ${this.describe()}`.replace(/[<>:"/\\|?*]/g, '');
  }
}
