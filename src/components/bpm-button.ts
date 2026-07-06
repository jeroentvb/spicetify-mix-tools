import { sortReorder, sortToNewPlaylist } from '../services/actions';

export const BUTTON_ID = 'sort-bpm-bpm-button';
const MENU_ID = 'sort-bpm-bpm-menu';

interface MenuAction {
   label: string;
   sublabel: string;
   run: () => void;
}

const ACTIONS: MenuAction[] = [
   { label: 'Reorder this playlist', sublabel: 'Sort by BPM in place', run: sortReorder },
   { label: 'Sort into new playlist', sublabel: 'Leaves the original untouched', run: sortToNewPlaylist },
];

function closeMenu(): void {
   document.getElementById(MENU_ID)?.remove();
   document.removeEventListener('click', onOutsideClick, true);
   document.removeEventListener('keydown', onKeydown, true);
}

function onOutsideClick(e: MouseEvent): void {
   const menu = document.getElementById(MENU_ID);
   const target = e.target as Node;
   if (menu && !menu.contains(target) && !document.getElementById(BUTTON_ID)?.contains(target)) {
      closeMenu();
   }
}

function onKeydown(e: KeyboardEvent): void {
   if (e.key === 'Escape') closeMenu();
}

function openMenu(anchor: HTMLElement): void {
   if (document.getElementById(MENU_ID)) return closeMenu();

   const menu = document.createElement('div');
   menu.id = MENU_ID;
   menu.className = 'sort-bpm-menu';

   for (const action of ACTIONS) {
      const item = document.createElement('button');
      item.className = 'sort-bpm-menu-item';
      item.type = 'button';
      item.innerHTML = `<span class="sort-bpm-menu-item-label">${action.label}</span>` +
         `<span class="sort-bpm-menu-item-sub">${action.sublabel}</span>`;
      item.addEventListener('click', () => {
         closeMenu();
         action.run();
      });
      menu.appendChild(item);
   }

   document.body.appendChild(menu);

   const rect = anchor.getBoundingClientRect();
   // Right-align the menu to the button, opening downwards.
   menu.style.top = `${rect.bottom + 4}px`;
   menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;

   // Defer so this same click doesn't immediately close the menu.
   setTimeout(() => {
      document.addEventListener('click', onOutsideClick, true);
      document.addEventListener('keydown', onKeydown, true);
   }, 0);
}

/** Metronome-ish glyph so the button reads as "tempo" at a glance. */
const ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">' +
   '<path d="M10.4 1H5.6L2 15h12L10.4 1zm-1.2 1.5 1 3.9-3.9 2.3.9-6.2h2zM4.7 11.2l4.9-2.9.9 3.6-6.2.1.4-.8z"/>' +
   '</svg>';

const IDLE_HTML = `${ICON}<span>BPM</span>`;

export function createBpmButton(): HTMLButtonElement {
   const button = document.createElement('button');
   button.id = BUTTON_ID;
   button.className = 'sort-bpm-button';
   button.type = 'button';
   button.setAttribute('aria-label', 'Sort by BPM');
   button.setAttribute('title', 'Sort by BPM');
   button.innerHTML = IDLE_HTML;
   button.addEventListener('click', (e) => {
      e.stopPropagation();
      openMenu(button);
   });
   return button;
}

/**
 * Reflect work-in-progress on the button. Pass a short label (e.g. "42%") to show
 * a busy/disabled state, or `null` to restore the idle button.
 */
export function setButtonBusy(label: string | null): void {
   const button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
   if (!button) return;

   if (label === null) {
      button.disabled = false;
      button.classList.remove('sort-bpm-button--busy');
      button.innerHTML = IDLE_HTML;
      button.setAttribute('aria-label', 'Sort by BPM');
   } else {
      button.disabled = true;
      button.classList.add('sort-bpm-button--busy');
      button.innerHTML = `${ICON}<span>${label}</span>`;
      button.setAttribute('aria-label', `Sorting by BPM… ${label}`);
   }
}
