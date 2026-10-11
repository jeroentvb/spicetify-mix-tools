import { setupInjection } from './components/inject';
import { getContents } from './services/playlist';
import { harvestColumnData, inspectRowItem } from './services/track-columns';
import { getCurrentPlaylistUri } from './services/current-uri';
import { getMixStats } from './services/mix';

import './assets/css/styles.scss';

async function main() {
   while (!Spicetify?.Platform?.History) {
      await new Promise((resolve) => setTimeout(resolve, 100));
   }

   setupInjection();

   // Debug helpers for the BPM/key-correctness verification step (see TECHNICAL.md).
   (window as typeof window & { sortBpm?: Record<string, unknown> }).sortBpm = {
      getCurrentPlaylistUri,
      getContents,
      getMixStats,
      harvestColumnData,
      inspectRowItem,
   };
}

export default main;
