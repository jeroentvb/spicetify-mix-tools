import { setupInjection } from './components/inject';
import { getContents } from './services/playlist';
import { harvestColumnBpm } from './services/bpm-column';
import { getCurrentPlaylistUri } from './services/current-uri';

import './assets/css/styles.scss';

async function main() {
   while (!Spicetify?.Platform || !Spicetify?.CosmosAsync || !Spicetify?.URI) {
      await new Promise((resolve) => setTimeout(resolve, 100));
   }

   setupInjection();

   // Debug helpers for the BPM-correctness verification step (see README).
   (window as typeof window & { mixTools?: Record<string, unknown> }).mixTools = {
      getCurrentPlaylistUri,
      getContents,
      harvestColumnBpm,
   };
}

export default main;
