import { ACTION_BAR, SORT_BUTTON } from '../constants/selectors';
import { getCurrentPlaylistUri } from '../services/current-uri';
import { queryFirst } from '../utils/wait-for-element';
import { BUTTON_ID, createBpmButton } from './bpm-button';
import { ensureMixTime } from './mix-time';

/**
 * Ensure the BPM button is present on playlist pages and absent elsewhere.
 * The button is placed just after (to the right of) the Sort button; if the
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

   if (sortButton) {
      // The sort button may sit in a non-flex wrapper (a plain block <div>); inserting inside it would
      // stack us below it, so go after that wrapper in the flex row instead.
      const parent = sortButton.parentElement;
      const anchor = parent && parent !== actionBar && !getComputedStyle(parent).display.includes('flex')
         ? parent
         : sortButton;
      anchor.after(button);
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
         ensureMixTime();
      });
   };

   ensureButton();
   ensureMixTime();

   new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
   Spicetify.Platform?.History?.listen?.(schedule);
}
