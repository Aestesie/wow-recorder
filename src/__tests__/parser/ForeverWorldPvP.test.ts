import { EventEmitter } from 'events';

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockConfig: Record<string, any> = {
  recordWorldPvP: true,
  recordWorldPvPDuels: true,
  obsRecEncoder: 'obs_x264',
  manualRecordSoundAlert: false,
};

const mockRecorder = {
  startRecording: jest.fn(async () => undefined),
  stop: jest.fn(async () => undefined),
  startBuffer: jest.fn(async () => undefined),
  getAndClearLastFile: jest.fn(() => 'C:/videos/2026-11-08 20-00-00.mp4'),
  getActiveReplayBufferLength: jest.fn(() => 120),
};

const mockQueueVideo = jest.fn();

jest.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));
jest.mock('../../main/main', () => ({ playSoundAlert: jest.fn() }));
jest.mock('../../main/util', () => ({
  emitErrorReport: jest.fn(),
  refreshInstantReplayState: jest.fn(),
}));
jest.mock('../../config/ConfigService', () => ({
  __esModule: true,
  default: { getInstance: () => ({ get: (k: string) => mockConfig[k] }) },
}));
jest.mock('../../main/Recorder', () => ({
  __esModule: true,
  default: { getInstance: () => mockRecorder },
}));
jest.mock('../../utils/Poller', () => ({
  __esModule: true,
  default: { getInstance: () => ({ isWowRunning: () => true }) },
}));
jest.mock('../../main/VideoProcessQueue', () => ({
  __esModule: true,
  default: { getInstance: () => ({ queueVideo: mockQueueVideo }) },
}));
jest.mock('../../parsing/CombatLogWatcher', () => {
  const { EventEmitter: EE } = require('events');
  return {
    __esModule: true,
    default: class extends EE {
      watch() {}

      unwatch() {}
    },
  };
});

import ForeverLogHandler from '../../parsing/ForeverLogHandler';
import LogHandler from '../../parsing/LogHandler';
import LogLine from '../../parsing/LogLine';
import { VideoCategory } from '../../types/VideoCategory';

const ME = 'Player-4701-0A1B2C3D,"Erturk-Forever-EU",0x511,0x0';
const MY_PET = 'Creature-0-4701-0-1-416-00000001,"Imp",0x1111,0x0';
const ENEMY = 'Player-4701-0E0E0E0E,"Gankster-Forever-EU",0x548,0x0';
const FRIEND = 'Player-4701-0F0F0F0F,"Buddy-Forever-EU",0x512,0x0';
const MOB = 'Creature-0-4701-0-1-1234-00000002,"Boar",0xa48,0x0';
const NIL = '0000000000000000,nil,0x80000000,0x80000000';

const BASE = new Date(2026, 10, 8, 20, 0, 0).getTime();
let handler: ForeverLogHandler;

const ts = (sec: number) => {
  const d = new Date(BASE + sec * 1000);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.0000`;
};

/**
 * Feed one line at log time `sec`, moving the wall clock to just after it,
 * like a live game writing the log.
 */
const feed = async (sec: number, body: string) => {
  jest.setSystemTime(BASE + sec * 1000 + 200);
  const line = new LogLine(`${ts(sec)}  ${body}`);
  (handler.combatLogWatcher as unknown as EventEmitter).emit(line.type(), line);
  await jest.advanceTimersByTimeAsync(0);
};

const hit = (src: string, dst: string) =>
  `SPELL_DAMAGE,${src},${dst},133,"Fireball",0x4,0000000000000000,0,0,0,0,0,0,-1,0,0,0,0.00,0.00,0,0.0000,0,812,700,-1,4,0,0,0,nil,nil,nil`;

const finish = async () => {
  // Idle timeout (15s) + post roll (5s) + slack.
  await jest.advanceTimersByTimeAsync(25_000);
};

const savedMetadata = () => mockQueueVideo.mock.calls.map((c) => c[0].metadata);

beforeEach(() => {
  jest.useFakeTimers({ now: BASE });
  jest.clearAllMocks();
  mockConfig.recordWorldPvP = true;
  mockConfig.recordWorldPvPDuels = true;
  LogHandler.dropActivity();
  LogHandler.setStateChangeCallback(() => {});
  handler = new ForeverLogHandler('C:/WoW/_forever_/Logs');
});

afterEach(() => {
  handler.destroy();
  jest.useRealTimers();
});

test('kill on an enemy player is clipped', async () => {
  await feed(0, hit(ME, ENEMY));
  await feed(2, hit(ENEMY, ME));
  expect(mockRecorder.startRecording).toHaveBeenCalledTimes(1);

  // Clip starts 10s before the first hit.
  const offset = (mockRecorder.startRecording.mock.calls[0] as any[])[0];
  expect(offset).toBeGreaterThanOrEqual(11.5);
  expect(offset).toBeLessThanOrEqual(12.5);

  await feed(5, `PARTY_KILL,${ME},${ENEMY},0`);
  await feed(5, `UNIT_DIED,${NIL},${ENEMY},0`);
  await finish();

  const [md] = savedMetadata();
  expect(savedMetadata()).toHaveLength(1);
  expect(md.category).toBe(VideoCategory.WorldPvP);
  expect(md.encounterName).toBe('Kill - Gankster-Forever-EU');
  expect(md.result).toBe(true);
  expect(md.deaths).toHaveLength(1);
  expect(md.deaths[0].friendly).toBe(false);
  // 10s pre roll + 5s fight + 5s post roll.
  expect(md.duration).toBe(20);
  expect(md.player._name).toBe('Erturk');
});

test('one-shot kill with no return damage still clips', async () => {
  await feed(0, hit(ME, ENEMY));
  expect(mockRecorder.startRecording).not.toHaveBeenCalled();
  await feed(1, `PARTY_KILL,${ME},${ENEMY},0`);
  await finish();
  expect(savedMetadata()[0].encounterName).toBe('Kill - Gankster-Forever-EU');
});

test('pet killing blow counts as our kill', async () => {
  await feed(0, hit(MY_PET, ENEMY));
  await feed(1, `PARTY_KILL,${MY_PET},${ENEMY},0`);
  await finish();
  expect(savedMetadata()[0].encounterName).toBe('Kill - Gankster-Forever-EU');
});

test('dying to a player is clipped as a death', async () => {
  await feed(0, hit(ENEMY, ME));
  await feed(3, hit(ENEMY, ME));
  await feed(4, `UNIT_DIED,${NIL},${ME},0`);
  await finish();

  const [md] = savedMetadata();
  expect(md.encounterName).toBe('Death - Gankster-Forever-EU');
  expect(md.result).toBe(false);
  expect(md.deaths[0].friendly).toBe(true);
});

test('confirmed duel with no deaths is clipped as a duel', async () => {
  await feed(0, `SPELL_CAST_SUCCESS,${ME},${FRIEND},7266,"Duel",0x1`);
  await feed(4, hit(ME, FRIEND));
  await feed(5, hit(FRIEND, ME));
  await feed(20, hit(ME, FRIEND));
  await finish();

  const [md] = savedMetadata();
  expect(md.encounterName).toBe('Duel - Buddy-Forever-EU');
  // Starts 10s before the duel cast.
  expect(md.duration).toBe(10 + 20 + 5);
});

test('localised duel spell name is recognised', async () => {
  await feed(0, `SPELL_CAST_SUCCESS,${FRIEND},${ME},0,"Düello",0x1`);
  await feed(3, hit(FRIEND, ME));
  await feed(4, hit(ME, FRIEND));
  await finish();
  expect(savedMetadata()[0].encounterName).toBe('Duel - Buddy-Forever-EU');
});

test('mutual damage without a duel cast is a fight', async () => {
  await feed(0, hit(ME, ENEMY));
  await feed(1, hit(ENEMY, ME));
  await finish();
  expect(savedMetadata()[0].encounterName).toBe('Fight - Gankster-Forever-EU');
});

test('non-lethal fights are discarded when duels are disabled', async () => {
  mockConfig.recordWorldPvPDuels = false;
  await feed(0, hit(ME, FRIEND));
  await feed(1, hit(FRIEND, ME));
  await finish();
  expect(mockRecorder.startRecording).toHaveBeenCalledTimes(1);
  expect(mockQueueVideo).not.toHaveBeenCalled();
});

test('one-sided damage with no outcome does not record', async () => {
  await feed(0, hit(ME, ENEMY));
  await feed(3, hit(ME, ENEMY));
  await finish();
  expect(mockRecorder.startRecording).not.toHaveBeenCalled();
});

test('dying to a mob is ignored', async () => {
  await feed(0, hit(MOB, ME));
  await feed(1, `UNIT_DIED,${NIL},${ME},0`);
  await finish();
  expect(mockRecorder.startRecording).not.toHaveBeenCalled();
});

test('death long after the last player hit is ignored', async () => {
  await feed(0, hit(ENEMY, ME));
  await feed(40, `UNIT_DIED,${NIL},${ME},0`);
  await finish();
  expect(mockRecorder.startRecording).not.toHaveBeenCalled();
});

test('separate engagements produce separate clips', async () => {
  await feed(0, hit(ME, ENEMY));
  await feed(1, `PARTY_KILL,${ME},${ENEMY},0`);
  await finish();

  await feed(60, hit(FRIEND, ME));
  await feed(61, hit(ME, FRIEND));
  await finish();

  expect(savedMetadata().map((m) => m.encounterName)).toEqual([
    'Kill - Gankster-Forever-EU',
    'Fight - Buddy-Forever-EU',
  ]);
});

test('disabled setting records nothing', async () => {
  mockConfig.recordWorldPvP = false;
  await feed(0, hit(ME, ENEMY));
  await feed(1, hit(ENEMY, ME));
  await feed(2, `PARTY_KILL,${ME},${ENEMY},0`);
  await finish();
  expect(mockRecorder.startRecording).not.toHaveBeenCalled();
});
