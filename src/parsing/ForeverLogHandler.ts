import Combatant from '../main/Combatant';
import { retailBattlegrounds, retailUniqueSpecSpells } from '../main/constants';
import LogHandler from './LogHandler';
import Battleground from '../activitys/Battleground';
import { Flavour, UnitFlags } from '../main/types';
import LogLine from './LogLine';
import { VideoCategory } from '../types/VideoCategory';
import { hasFlag, isUnitPlayer, isUnitSelf } from './logutils';
import RaidEncounter from 'activitys/RaidEncounter';
import WorldPvP from 'activitys/WorldPvP';
import ConfigService from '../config/ConfigService';
import Recorder from '../main/Recorder';

/**
 * World PvP clip tuning. Seconds.
 *
 * PRE_ROLL:  how far before the first hit of the engagement the clip starts.
 * POST_ROLL: how long the clip continues after the last PvP event.
 * IDLE:      how long without any PvP event before the engagement is over.
 */
const WORLD_PVP_PRE_ROLL = 10;
const WORLD_PVP_POST_ROLL = 5;
const WORLD_PVP_IDLE = 15;

/**
 * Combat log events that count as two players fighting. Misses are included
 * so a fully dodged / resisted opener still counts as engagement.
 */
const PVP_COMBAT_EVENTS = [
  'SWING_DAMAGE',
  'SWING_MISSED',
  'RANGE_DAMAGE',
  'RANGE_MISSED',
  'SPELL_DAMAGE',
  'SPELL_MISSED',
  'SPELL_PERIODIC_DAMAGE',
  'SPELL_PERIODIC_MISSED',
  'DAMAGE_SPLIT',
];

/**
 * The Duel spell. Name matched too as a fallback, localised clients log the
 * localised name.
 */
const DUEL_SPELL_ID = 7266;
const DUEL_SPELL_NAMES = [
  'Duel',
  'Duell',
  'Düello',
  'Duelo',
  'Duello',
  'Поединок',
  '결투',
  '决斗',
  '決鬥',
];

type PendingPvPEvent =
  | {
      type: 'damage';
      date: Date;
      guid: string;
      name: string;
      outgoing: boolean;
    }
  | { type: 'duel'; guid: string };

/**
 * PvP activity seen while no clip is recording yet. We only start recording
 * once something worth keeping is likely (mutual damage, a kill or a death),
 * then cut back into the replay buffer to the start of the engagement.
 */
type PendingEngagement = {
  start: Date;
  last: Date;
  lastIncoming?: Date;
  dealtTo: Set<string>;
  takenFrom: Set<string>;
  events: PendingPvPEvent[];
};

export default class ForeverLogHandler extends LogHandler {
  constructor(logPath: string) {
    super(logPath, 10);

    /* eslint-disable prettier/prettier */
    this.combatLogWatcher
      .on('ENCOUNTER_START',      (line: LogLine) => { this.logProcessQueue.add(async () =>  this.handleEncounterStartLine(line));})
      .on('ENCOUNTER_END',        (line: LogLine) => { this.logProcessQueue.add(async () => this.handleEncounterEndLine(line)); })
      .on('ZONE_CHANGE',          (line: LogLine) => { this.logProcessQueue.add(async () => this.handleZoneChange(line)); })
      .on('SPELL_AURA_APPLIED',   (line: LogLine) => { this.logProcessQueue.add(async () => this.handleSpellAuraAppliedLine(line)); })
      .on('SPELL_AURA_REMOVED',   (line: LogLine) => { this.logProcessQueue.add(async () => this.handleSpellAuraRemovedLine(line)); })
      .on('UNIT_DIED',            (line: LogLine) => { this.logProcessQueue.add(async () => this.handleForeverUnitDied(line)); })
      .on('COMBATANT_INFO',       (line: LogLine) => { this.logProcessQueue.add(async () => this.handleCombatantInfoLine(line)); })
      .on('SPELL_CAST_START',     (line: LogLine) => { this.logProcessQueue.add(async () => this.handleSpellCastStart(line)); })
      .on('SPELL_CAST_SUCCESS',   (line: LogLine) => { this.logProcessQueue.add(async () => this.handleSpellCastSuccess(line)); })
      .on('SPELL_DAMAGE',         (line: LogLine) => { this.logProcessQueue.add(async () => this.handleSpellDamage(line)); })
      .on('PARTY_KILL',           (line: LogLine) => { this.logProcessQueue.add(async () => this.handlePartyKill(line)); });
    /* eslint-enable prettier/prettier */

    PVP_COMBAT_EVENTS.forEach((event) => {
      this.combatLogWatcher.on(event, (line: LogLine) => {
        this.logProcessQueue.add(async () => this.handlePvPCombatLine(line));
      });
    });
  }

  private engagement?: PendingEngagement;

  private worldPvPTimer?: NodeJS.Timeout;

  private self?: { guid: string; name: string; flags: number };

  public destroy() {
    if (this.worldPvPTimer) clearTimeout(this.worldPvPTimer);
    super.destroy();
  }

  private static worldPvPEnabled() {
    return ConfigService.getInstance().get<boolean>('recordWorldPvP');
  }

  private static isWorldPvPActive() {
    return LogHandler.activity instanceof WorldPvP;
  }

  /**
   * True if some other activity (raid, BG, manual...) owns the recorder, in
   * which case world PvP is ignored; it's already being recorded.
   */
  private static isOtherActivityActive() {
    if (LogHandler.overrunning) return true;
    return (
      Boolean(LogHandler.activity) && !ForeverLogHandler.isWorldPvPActive()
    );
  }

  /**
   * Units that belong to us: our character, pets and guardians.
   */
  private static isMine(flags: number) {
    return hasFlag(flags, UnitFlags.AFFILIATION_MINE);
  }

  private static isSelfPlayer(flags: number) {
    return isUnitSelf(flags) && hasFlag(flags, UnitFlags.TYPE_PLAYER);
  }

  private rememberSelf(guid: string, name: string, flags: number) {
    if (!ForeverLogHandler.isSelfPlayer(flags)) return;
    if (this.self?.guid === guid) return;
    this.self = { guid, name, flags };
  }

  /**
   * Damage or a miss between us (or our pet) and another player.
   */
  private async handlePvPCombatLine(line: LogLine) {
    if (ForeverLogHandler.isOtherActivityActive()) return;
    if (!ForeverLogHandler.worldPvPEnabled()) return;

    const srcFlags = parseInt(line.arg(3), 16);
    const dstFlags = parseInt(line.arg(7), 16);
    const srcMine = ForeverLogHandler.isMine(srcFlags);
    const dstMine = ForeverLogHandler.isMine(dstFlags);

    // Outgoing: we or our pet hit another player. Incoming: another player
    // hit our character. Hits on our pet alone don't count.
    const outgoing = srcMine && !dstMine && isUnitPlayer(dstFlags);
    const incoming =
      !srcMine &&
      isUnitPlayer(srcFlags) &&
      ForeverLogHandler.isSelfPlayer(dstFlags);

    if (!outgoing && !incoming) return;

    const date = line.date();
    const guid = outgoing ? line.arg(5) : line.arg(1);
    const name = outgoing ? line.arg(6) : line.arg(2);

    if (outgoing) this.rememberSelf(line.arg(1), line.arg(2), srcFlags);
    else this.rememberSelf(line.arg(5), line.arg(6), dstFlags);

    if (ForeverLogHandler.isWorldPvPActive()) {
      const activity = LogHandler.activity as WorldPvP;
      activity.onPvPDamage(date, guid, name, outgoing);
      this.addWorldPvPCombatant(guid, name, outgoing ? dstFlags : srcFlags);
      this.armWorldPvPTimer();
      return;
    }

    const eng = this.touchEngagement(date);
    eng.events.push({ type: 'damage', date, guid, name, outgoing });

    if (outgoing) {
      eng.dealtTo.add(guid);
    } else {
      eng.takenFrom.add(guid);
      eng.lastIncoming = date;
    }

    // Damage both ways with the same player: a real fight or a duel.
    if (eng.dealtTo.has(guid) && eng.takenFrom.has(guid)) {
      console.info('[ForeverLogHandler] Mutual PvP damage with', name);
      await this.startWorldPvP();
    }
  }

  /**
   * Get the pending engagement, starting a new one if there is none or the
   * last one has gone idle.
   */
  private touchEngagement(date: Date) {
    const idle =
      !this.engagement ||
      date.getTime() - this.engagement.last.getTime() > WORLD_PVP_IDLE * 1000;

    if (idle) {
      this.engagement = {
        start: date,
        last: date,
        dealtTo: new Set(),
        takenFrom: new Set(),
        events: [],
      };
    }

    const eng = this.engagement as PendingEngagement;
    eng.last = date;

    // Keep memory bounded on long one-sided engagements.
    if (eng.events.length > 500) eng.events.splice(0, eng.events.length - 500);

    return eng;
  }

  /**
   * Killing blow by us or our pet on a player.
   */
  private async handlePartyKill(line: LogLine) {
    if (ForeverLogHandler.isOtherActivityActive()) return;
    if (!ForeverLogHandler.worldPvPEnabled()) return;

    const srcFlags = parseInt(line.arg(3), 16);
    const dstFlags = parseInt(line.arg(7), 16);

    if (!ForeverLogHandler.isMine(srcFlags)) return;
    if (!isUnitPlayer(dstFlags) || ForeverLogHandler.isMine(dstFlags)) return;

    const date = line.date();
    const guid = line.arg(5);
    const name = line.arg(6);
    console.info('[ForeverLogHandler] World PvP kill:', name);

    this.rememberSelf(line.arg(1), line.arg(2), srcFlags);

    if (!ForeverLogHandler.isWorldPvPActive()) {
      this.touchEngagement(date);
      await this.startWorldPvP();
    }

    if (!ForeverLogHandler.isWorldPvPActive()) return;
    const activity = LogHandler.activity as WorldPvP;
    activity.onKill(date, guid, name);
    this.addWorldPvPCombatant(guid, name, dstFlags);
    this.armWorldPvPTimer();
  }

  /**
   * Our own death while fighting players. Deaths to mobs with no player
   * involvement in the last WORLD_PVP_IDLE seconds are ignored.
   */
  private async handleWorldPvPDeath(line: LogLine) {
    const dstFlags = parseInt(line.arg(7), 16);
    if (!ForeverLogHandler.isSelfPlayer(dstFlags)) return;

    const date = line.date();
    const name = line.arg(6);
    this.rememberSelf(line.arg(5), name, dstFlags);

    if (!ForeverLogHandler.isWorldPvPActive()) {
      const recentPvP =
        this.engagement?.lastIncoming &&
        date.getTime() - this.engagement.lastIncoming.getTime() <=
          WORLD_PVP_IDLE * 1000;

      if (!recentPvP) return;

      console.info('[ForeverLogHandler] Died during world PvP');
      await this.startWorldPvP();
    }

    if (!ForeverLogHandler.isWorldPvPActive()) return;
    const activity = LogHandler.activity as WorldPvP;
    activity.onPlayerDeath(date, name);
    this.armWorldPvPTimer();
  }

  private async handleForeverUnitDied(line: LogLine) {
    if (ForeverLogHandler.isWorldPvPActive()) {
      // Base class death tracking assumes instanced content; world PvP
      // tracks our own death and kills (PARTY_KILL) itself.
      await this.handleWorldPvPDeath(line);
      return;
    }

    this.handleUnitDiedLine(line);

    if (!LogHandler.activity && ForeverLogHandler.worldPvPEnabled()) {
      await this.handleWorldPvPDeath(line);
    }
  }

  /**
   * Duel cast between us and another player. Marks that player as a duel
   * opponent so the clip is labelled as a duel.
   */
  private handleDuelCast(line: LogLine) {
    const spellID = parseInt(line.arg(9), 10);
    const spellName = line.arg(10);
    const isDuel =
      spellID === DUEL_SPELL_ID || DUEL_SPELL_NAMES.includes(spellName);

    if (!isDuel) return;

    const srcFlags = parseInt(line.arg(3), 16);
    const dstFlags = parseInt(line.arg(7), 16);
    let opponent: string | undefined;

    if (ForeverLogHandler.isSelfPlayer(srcFlags)) opponent = line.arg(5);
    else if (ForeverLogHandler.isSelfPlayer(dstFlags)) opponent = line.arg(1);
    if (!opponent) return;

    console.info('[ForeverLogHandler] Duel cast with', opponent);

    if (ForeverLogHandler.isWorldPvPActive()) {
      (LogHandler.activity as WorldPvP).onDuelCast(opponent);
      return;
    }

    // The duel countdown runs before any damage, so start a fresh engagement
    // here and remember the opponent for when the recording starts.
    const eng = this.touchEngagement(line.date());
    eng.events.push({ type: 'duel', guid: opponent });
  }

  private addWorldPvPCombatant(guid: string, name: string, flags: number) {
    this.processCombatant(guid, name, flags, true);
  }

  /**
   * Start a world PvP recording, cutting back into the replay buffer to just
   * before the start of the pending engagement.
   */
  private async startWorldPvP() {
    if (LogHandler.activity || LogHandler.overrunning) return;

    const eng = this.engagement;
    const now = Date.now();
    const engagementStart = eng ? eng.start.getTime() : now;
    let start = engagementStart - WORLD_PVP_PRE_ROLL * 1000;

    // We can't cut back further than the replay buffer goes.
    const bufferSec = Recorder.getInstance().getActiveReplayBufferLength();

    if (bufferSec) {
      start = Math.max(start, now - (bufferSec - 1) * 1000);
    }

    start = Math.min(start, now);

    const includeDuels = ConfigService.getInstance().get<boolean>(
      'recordWorldPvPDuels',
    );

    const activity = new WorldPvP(
      new Date(start),
      Flavour.Forever,
      includeDuels,
    );
    const started = await LogHandler.startActivity(activity);

    if (!started) {
      console.warn('[ForeverLogHandler] Failed to start world PvP recording');
      this.engagement = undefined;
      return;
    }

    if (this.self) {
      const { guid, name, flags } = this.self;
      started.playerGUID = guid;
      this.processCombatant(guid, name, flags, true);
    }

    // Replay what happened before the recording started.
    eng?.events.forEach((e) => {
      if (e.type === 'duel') {
        activity.onDuelCast(e.guid);
        return;
      }

      activity.onPvPDamage(e.date, e.guid, e.name, e.outgoing);

      if (!activity.getCombatant(e.guid)) {
        const flags = UnitFlags.CONTROL_PLAYER | UnitFlags.TYPE_PLAYER;
        this.addWorldPvPCombatant(e.guid, e.name, flags);
      }
    });

    this.engagement = undefined;
    this.armWorldPvPTimer();
  }

  /**
   * (Re)start the idle timer that ends the world PvP recording.
   */
  private armWorldPvPTimer() {
    if (this.worldPvPTimer) clearTimeout(this.worldPvPTimer);

    this.worldPvPTimer = setTimeout(() => {
      this.logProcessQueue.add(async () => this.endWorldPvP());
    }, WORLD_PVP_IDLE * 1000);
  }

  private async endWorldPvP() {
    if (this.worldPvPTimer) clearTimeout(this.worldPvPTimer);
    this.worldPvPTimer = undefined;

    if (!ForeverLogHandler.isWorldPvPActive()) return;
    const activity = LogHandler.activity as WorldPvP;

    console.info(
      '[ForeverLogHandler] World PvP engagement over, outcome:',
      activity.outcome,
    );

    activity.overrun = WORLD_PVP_POST_ROLL;
    activity.end(
      new Date(activity.lastPvPDate),
      activity.outcome !== undefined,
    );
    await LogHandler.endActivity();
  }

  protected async handleEncounterStartLine(line: LogLine) {
    console.debug('[ForeverLogHandler] Handling ENCOUNTER_START line:', line);

    if (this.isManual()) {
      console.info('[ForeverLogHandler] Ignoring line as in manual recording');
      return;
    }

    if (ForeverLogHandler.isWorldPvPActive()) {
      console.info('[ForeverLogHandler] Ending world PvP clip for encounter');
      await this.endWorldPvP();
    }

    if (LogHandler.activity) {
      console.error('[ForeverLogHandler] Encounter is already in progress');
    } else {
      await super.handleEncounterStartLine(line, Flavour.Forever);
    }
  }

  protected async handleEncounterEndLine(line: LogLine) {
    console.debug('[ForeverLogHandler] Handling ENCOUNTER_END line:', line);

    if (this.isManual()) {
      console.info('[ForeverLogHandler] Ignoring line as in manual recording');
      return;
    }

    if (ForeverLogHandler.isWorldPvPActive()) {
      console.info(
        '[ForeverLogHandler] Encounter end during world PvP, ignore',
      );
      return;
    }

    if (LogHandler.activity) {
      console.debug('[ForeverLogHandler] Must be raid encounter');
      await super.handleEncounterEndLine(line);
    } else {
      console.error('[ForeverLogHandler] Encounter end event but no activity');
    }
  }

  private async handleZoneChange(line: LogLine) {
    console.info('[ForeverLogHandler] Handling ZONE_CHANGE line:', line);

    if (this.isManual()) {
      console.info('[ForeverLogHandler] Ignoring line as in manual recording');
      return;
    }

    const zoneID = parseInt(line.arg(1), 10);

    const isZoneBG = Object.prototype.hasOwnProperty.call(
      retailBattlegrounds,
      zoneID,
    );

    if (LogHandler.activity) {
      const { category } = LogHandler.activity;
      const isActivityBG = category === VideoCategory.Battlegrounds;
      const isActivityArena = this.isArena();

      if (isZoneBG && isActivityBG) {
        console.info('[ForeverLogHandler] Internal BG zone change: ', zoneID);
      } else if (!isZoneBG && isActivityBG) {
        console.info('[ForeverLogHandler] Zone change out of BG');
        await this.battlegroundEnd(line);
      } else if (isActivityArena) {
        if (zoneID === LogHandler.activity.zoneID) {
          console.info(
            '[ForeverLogHandler] ZONE_CHANGE within arena, no action taken',
          );
        } else {
          console.info(
            '[ForeverLogHandler] ZONE_CHANGE out of arena, ending match',
          );
          await this.zoneChangeStop(line);
        }
      } else if (isZoneBG && !isActivityBG) {
        console.error(
          '[ForeverLogHandler] Zoned into BG but in a different activity',
        );

        await LogHandler.forceEndActivity();
        await this.battlegroundStart(line);
      } else {
        console.info(
          '[ForeverLogHandler] Unknown zone change, no action taken: ',
          zoneID,
        );
      }
    } else if (isZoneBG) {
      console.info('[ForeverLogHandler] Zone change into BG');
      await this.battlegroundStart(line);
    } else {
      console.info('[ForeverLogHandler] Uninteresting zone change');
    }
  }

  private handleCombatantInfoLine(line: LogLine): void {
    console.info('[ForeverLogHandler] Handling COMBATANT_INFO line:', line);

    if (this.isManual()) {
      console.info('[ForeverLogHandler] Ignoring line as in manual recording');
      return;
    }

    if (!LogHandler.activity) {
      console.warn(
        '[ForeverLogHandler] No activity in progress, ignoring COMBATANT_INFO',
      );
      return;
    }

    const GUID = line.arg(1);

    // In dungeons we see COMBANTANT_INFO events for each encounter.
    // Don't bother overwriting them if we have them already.
    const combatant = LogHandler.activity.getCombatant(GUID);

    if (combatant && combatant.isFullyDefined()) {
      return;
    }

    const teamID = parseInt(line.arg(2), 10);
    const specID = parseInt(line.arg(25), 10);

    console.info(
      '[ForeverLogHandler] Adding combatant from COMBATANT_INFO',
      GUID,
      teamID,
      specID,
    );

    const newCombatant = new Combatant(GUID, teamID, specID);
    LogHandler.activity.addCombatant(newCombatant);
  }

  private handleSpellAuraAppliedLine(line: LogLine) {
    if (!LogHandler.activity || this.isManual()) {
      // Deliberately don't log anything here as we can hit this a lot
      return;
    }

    const srcGUID = line.arg(1);
    const srcFlags = parseInt(line.arg(3), 16);
    const srcNameRealm = line.arg(2);

    // The isUnitSelf() check is important here as for dungeons we won't see
    // COMBATANT_INFO events till the boss is pulled, which would cause
    // us to drop the recording on an abandoned run with no boss pulls.
    // Adding the combatant here if it's ourselves ensures we atleast
    // have a partially defined combatant. See issue 650 & 683.
    const allowNew = this.isBattleground() || isUnitSelf(srcFlags);
    this.processCombatant(srcGUID, srcNameRealm, srcFlags, allowNew);

    if (this.isRaid()) {
      const raid = LogHandler.activity as RaidEncounter;
      raid.onSpellAuraApplied(line);
    }
  }

  private handleSpellAuraRemovedLine(line: LogLine) {
    if (this.isRaid()) {
      const raid = LogHandler.activity as RaidEncounter;
      raid.onSpellAuraRemoved(line);
    }
  }

  private handleSpellCastStart(line: LogLine) {
    if (this.isRaid()) {
      const raid = LogHandler.activity as RaidEncounter;
      raid.onSpellCastStart(line);
    }
  }

  private handleSpellCastSuccess(line: LogLine) {
    if (
      ForeverLogHandler.worldPvPEnabled() &&
      !ForeverLogHandler.isOtherActivityActive()
    ) {
      this.handleDuelCast(line);
    }

    if (!LogHandler.activity || this.isManual()) {
      // Deliberately don't log anything here as we can hit this a lot
      return;
    }

    if (this.isRaid()) {
      const raid = LogHandler.activity as RaidEncounter;
      raid.onSpellCastSuccess(line);
    }

    const srcGUID = line.arg(1);
    const srcName = line.arg(2);
    const srcFlags = parseInt(line.arg(3), 16);

    // The isUnitSelf() check is important here as for dungeons we won't see
    // COMBATANT_INFO events till the boss is pulled, which would cause
    // us to drop the recording on an abandoned run with no boss pulls.
    // Adding the combatant here if it's ourselves ensures we atleast
    // have a partially defined combatant. See issue 650 & 683.
    const allowNew = this.isBattleground() || isUnitSelf(srcFlags);

    const combatant = this.processCombatant(
      srcGUID,
      srcName,
      srcFlags,
      allowNew,
    );

    if (
      combatant === undefined ||
      combatant.specID !== undefined ||
      !this.isBattleground()
    ) {
      // Nothing to do here either of:
      //   - No combatant was processed (e.g. it's not a player)
      //   - We already know their spec (we've already processed them)
      //   - It's not a BG (every other retail activity fires COMBATANT_INFO)
      return;
    }

    const spellName = line.arg(10);

    const knownSpell = Object.prototype.hasOwnProperty.call(
      retailUniqueSpecSpells,
      spellName,
    );

    if (knownSpell) {
      combatant.specID = retailUniqueSpecSpells[spellName];
    }
  }

  private async battlegroundStart(line: LogLine) {
    if (LogHandler.activity) {
      console.error(
        "[ForeverLogHandler] Another activity in progress, can't start battleground",
      );
      return;
    }

    const startTime = line.date();
    const category = VideoCategory.Battlegrounds;
    const zoneID = parseInt(line.arg(1), 10);

    const activity = new Battleground(
      startTime,
      category,
      zoneID,
      Flavour.Forever,
    );

    await LogHandler.startActivity(activity);
  }

  private async battlegroundEnd(line: LogLine) {
    if (!LogHandler.activity) {
      console.error(
        "[ForeverLogHandler] Can't stop battleground as no active activity",
      );
      return;
    }

    const endTime = line.date();
    LogHandler.activity.end(endTime, false);
    await LogHandler.endActivity();
  }
}
