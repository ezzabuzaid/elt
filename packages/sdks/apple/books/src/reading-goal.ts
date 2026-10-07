import { readFile } from 'node:fs/promises';

import {
  type PlistValue,
  isBinaryPlist,
  parseBinaryPlist,
} from '@workspace/codec-plist';

import { dictionary, integer, plistTime } from './books-values.ts';
import { BooksSchemaError, BooksUnavailableError } from './errors.ts';

// The daily reading goal and streak Books shows in Reading Goals.
export type ReadingGoal = {
  // Whether Reading Goals is on; NULL when Books has not stored a boolean.
  readonly enabled: boolean | null;
  readonly dailyGoalSeconds: number | null;
  readonly goalSetAt: Date | null;
  readonly currentStreakDays: number | null;
};

// One of Books' preference files, whole. A missing or unreadable file fails
// the read; it never reads as empty preferences.
async function readBooksPlist(path: string): Promise<PlistValue> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new BooksUnavailableError(path, cause);
  }
  if (!isBinaryPlist(bytes))
    throw new BooksSchemaError(path, ['binary property list']);
  return parseBinaryPlist(bytes);
}

// The goal from Books' own preferences and the ones it shares with
// bookdatastored, read in that order. Each keeps part of it: the app's goal
// wins, the shared file's date wins, and only the shared file says whether
// goals are on.
export async function readingGoal(
  appPath: string,
  sharedPath: string,
): Promise<ReadingGoal> {
  const app = dictionary(await readBooksPlist(appPath));
  const shared = dictionary(await readBooksPlist(sharedPath));
  const goal = dictionary(shared.streakDatUserDefaultsKey);
  const appGoal = dictionary(app['ReadingGoals.StreakDay']);
  const enabled = shared.BKReadingGoalsUserDefaultsKey;
  return {
    enabled: typeof enabled === 'boolean' ? enabled : null,
    dailyGoalSeconds: integer(appGoal.goal) ?? integer(goal.goal),
    goalSetAt: plistTime(goal.date) ?? plistTime(appGoal.date),
    currentStreakDays: integer(app['ReadingHistory.CurrentStreak']),
  };
}
