import { AppDatabase, Store } from '@eltjs/sdk-macos-app-database';

export const biomeStore = new Store("Biome's store", {
  missing: '',
  grant: 'full-disk-access',
});

export const appDatabase = new AppDatabase(biomeStore);
