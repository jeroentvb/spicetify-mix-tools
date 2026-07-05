import { ACTION_BAR, SORT_BUTTON } from '../constants/selectors';
import { getCurrentPlaylistUri } from '../services/current-uri';
import { queryFirst } from '../utils/wait-for-element';
import { BUTTON_ID, createBpmButton } from './bpm-button';

/**
 * Ensure the BPM button is present on playlist pages and absent elsewhere.
 * The button is placed just before the Sort button in the action bar; if the
 * Sort button can't be located we fall back to appending to the action bar.
 */
function ensureButton(): void {
   const onPlaylist = getCurrentPlaylistUri() !== null;
   const existing = document.getElementById(BUTTON_ID);

   if (!onPlaylist) {
      existing?.remove();
      return;
   }
   if (existing) return;

   const actionBar = queryFirst(document, ACTION_BAR);
   if (!actionBar) return;

   const button = createBpmButton();
   const sortButton = queryFirst(actionBar, SORT_BUTTON);

   if (sortButton?.parentElement) {
      sortButton.parentElement.insertBefore(button, sortButton);
   } else {
      actionBar.appendChild(button);
   }
}

/**
 * Keep the button in sync as the user navigates and as Spotify re-renders the
 * (virtualized) view. A debounced MutationObserver covers re-renders; History
 * covers client-side navigation.
 */
export function setupInjection(): void {
   let scheduled = false;
   const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
         scheduled = false;
         ensureButton();
      });
   };

   ensureButton();

   new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
   Spicetify.Platform?.History?.listen?.(schedule);
}
