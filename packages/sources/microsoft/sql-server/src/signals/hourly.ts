import { ChangeSignal, type Check } from './change-signal.ts';

const hour = 60 * 60_000;

// The whole hours since the watch started, the same for every table: a
// stream that names it reloads once an hour, which finds a change that its
// other signals cannot see.
class Hourly extends ChangeSignal {
  async read({ started, now }: Check) {
    const hours = Math.floor((now - started) / hour);
    return () => hours;
  }
}

export const hourly = new Hourly();
