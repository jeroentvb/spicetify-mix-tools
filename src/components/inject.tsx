import React from 'react';

import { ACTION_BAR, SORT_BUTTON } from '../constants/selectors';
import { getCurrentPlaylistUri } from '../services/current-uri';
import { mount, sweepDetached, unmount } from '../utils/mount';
import { queryFirst } from '../utils/wait-for-element';
import { BpmButton } from './bpm-button';
import { ensureMixTime } from './mix-time';

/**
 * Ensure the BPM button is present on playlist pages and absent elsewhere.
 * The button is placed just after (to the right of) the Sort button; if the
 * Sort button can't be located we fall back to appending to the action bar.
 */
const BUTTON_HOST_ID = 'mix-tools-bpm-root';

function ensureButton(): void {
   const onPlaylist = getCurrentPlaylistUri() !== null;
   const existing = document.getElementById(BUTTON_HOST_ID);

   if (!onPlaylist) {
      unmount(existing);
      return;
   }
   if (existing) return;

   const actionBar = queryFirst(document, ACTION_BAR);
   if (!actionBar) return;

   // `display: contents` (see styles), so the button lays out as a direct child of the flex row.
   const button = document.createElement('span');
   button.id = BUTTON_HOST_ID;
   button.className = 'mix-tools-root';
   mount(button, <BpmButton />);
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
         sweepDetached();
         ensureButton();
         ensureMixTime();
      });
   };

   ensureButton();
   ensureMixTime();

   new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
   Spicetify.Platform?.History?.listen?.(schedule);
}
