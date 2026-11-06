import { ChangeSignal, type Check } from './change-signal.ts';

// The database's last committed Change Tracking version: each change to a
// tracked table moves it, in the transaction of the change, and a restart
// keeps it.
class ChangeTrackingVersion extends ChangeSignal {
  async read({ session }: Check) {
    const { changeTracking } = await session.version();
    return () => changeTracking;
  }
}

export const changeTrackingVersion = new ChangeTrackingVersion();
