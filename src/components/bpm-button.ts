import {
   sortReorderByBpm,
   sortReorderByKey,
   sortToNewPlaylistByBpm,
   sortToNewPlaylistByKey,
} from '../services/actions';
import { getCurrentPlaylistUri } from '../services/current-uri';
import { canModify } from '../services/playlist';

export const BUTTON_ID = 'mix-tools-bpm-button';
const MENU_ID = 'mix-tools-bpm-menu';
const SUBMENU_ID = 'mix-tools-bpm-submenu';

/** Gap kept between any menu and the viewport edge. */
const EDGE_MARGIN = 8;
/** Mirrors `.mix-tools-menu`'s padding, so a submenu's first row lines up with its parent row. */
const MENU_PADDING = 4;
/** Horizontal overlap with the parent menu, so the pointer can cross without leaving both. */
const SUBMENU_OVERLAP = 2;
/** Grace period while the pointer travels between a parent row and its submenu. */
const SUBMENU_CLOSE_DELAY = 220;

/** A leaf row: the thing that actually runs a sort. */
interface MenuLeaf {
   label: string;
   sublabel: string;
   run: () => void;
}

/** A top-level row: a destination, which expands into one leaf per sort mode. */
interface MenuEntry {
   label: string;
   sublabel: string;
   items: MenuLeaf[];
   /** Only offered on playlists the user can edit; otherwise shown disabled with this sublabel. */
   requiresEdit?: string;
}

/** The two sort modes, spelled the same way under every destination. */
function modeLeaves(byBpm: () => void, byKey: () => void): MenuLeaf[] {
   return [
      { label: 'by BPM', sublabel: 'Tempo, ascending', run: byBpm },
      { label: 'by key + BPM', sublabel: 'Camelot order, tempo within key', run: byKey },
   ];
}

const ACTIONS: MenuEntry[] = [
   {
      label: 'Reorder this playlist',
      sublabel: 'In place · keeps date added',
      items: modeLeaves(sortReorderByBpm, sortReorderByKey),
      requiresEdit: 'Only for playlists you own',
   },
   {
      label: 'Sort into new playlist',
      sublabel: 'Leaves the original untouched',
      items: modeLeaves(sortToNewPlaylistByBpm, sortToNewPlaylistByKey),
   },
];

/** The parent row whose submenu is currently open, if any. Only ever one at a time. */
let openParent: HTMLElement | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Whether the menu was opened from the keyboard. Only then do we move focus into it:
 * stealing focus on a mouse click can scroll Spotify's virtualized tracklist, and leaves
 * a stray focus ring on the first row.
 */
let keyboardOpened = false;

function cancelClose(): void {
   if (closeTimer !== undefined) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
   }
}

function scheduleClose(): void {
   cancelClose();
   closeTimer = setTimeout(closeSubmenu, SUBMENU_CLOSE_DELAY);
}

/** The focusable rows of a menu, in visual order. */
function rows(menu: Element): HTMLElement[] {
   return Array.from(menu.querySelectorAll<HTMLElement>('.mix-tools-menu-item'));
}

function closeSubmenu(): void {
   cancelClose();
   document.getElementById(SUBMENU_ID)?.remove();
   if (openParent) {
      openParent.setAttribute('aria-expanded', 'false');
      openParent.classList.remove('mix-tools-menu-item--open');
      openParent = null;
   }
}

function closeMenu(): void {
   closeSubmenu();
   keyboardOpened = false;
   document.getElementById(MENU_ID)?.remove();
   document.removeEventListener('click', onOutsideClick, true);
   document.removeEventListener('keydown', onKeydown, true);
   window.removeEventListener('resize', closeMenu);
   window.removeEventListener('scroll', closeMenu, true);
}

/** Whether a click landed on the button or inside either menu level. */
function isInsideMenu(target: Node): boolean {
   return [MENU_ID, SUBMENU_ID, BUTTON_ID].some((id) => document.getElementById(id)?.contains(target));
}

function onOutsideClick(e: MouseEvent): void {
   if (!isInsideMenu(e.target as Node)) closeMenu();
}

function moveFocus(menu: Element, delta: number): void {
   const list = rows(menu);
   if (list.length === 0) return;

   const current = list.indexOf(document.activeElement as HTMLElement);
   if (current === -1) {
      list[delta > 0 ? 0 : list.length - 1]?.focus({ preventScroll: true });
      return;
   }
   list[(current + delta + list.length) % list.length]?.focus({ preventScroll: true });
}

/** Close the submenu and put focus back on the row that opened it. */
function leaveSubmenu(): void {
   const parent = openParent;
   closeSubmenu();
   parent?.focus({ preventScroll: true });
}

function onKeydown(e: KeyboardEvent): void {
   const menu = document.getElementById(MENU_ID);
   if (!menu) return;

   const submenu = document.getElementById(SUBMENU_ID);
   const active = document.activeElement;
   const inSubmenu = submenu !== null && active !== null && submenu.contains(active);

   // Every branch that handles a key also stops propagation, so the client's own global
   // shortcuts don't fire underneath us — Space (play/pause) especially.
   const handled = () => {
      e.preventDefault();
      e.stopPropagation();
   };

   switch (e.key) {
      case 'Escape': {
         handled();
         if (submenu) {
            leaveSubmenu();
         } else {
            closeMenu();
            document.getElementById(BUTTON_ID)?.focus({ preventScroll: true });
         }
         return;
      }

      case 'ArrowDown':
      case 'ArrowUp': {
         handled();
         moveFocus(inSubmenu && submenu ? submenu : menu, e.key === 'ArrowDown' ? 1 : -1);
         return;
      }

      case 'ArrowRight':
      case 'Enter':
      case ' ': {
         if (!(active instanceof HTMLElement) || !active.classList.contains('mix-tools-menu-item')) return;
         // ArrowRight only opens a submenu — it must not activate a leaf.
         const isParent = active.classList.contains('mix-tools-menu-item--parent');
         if (e.key === 'ArrowRight' && !isParent) return;

         // Activate through click() rather than letting the button do it natively: this
         // handler runs in the capture phase, so stopping propagation here would other-
         // wise prevent the event from ever reaching the button.
         handled();
         active.click();
         return;
      }

      case 'ArrowLeft': {
         if (!inSubmenu) return;
         handled();
         leaveSubmenu();
         return;
      }

      case 'Tab': {
         // Menus don't trap Tab — close and let focus move on naturally.
         closeMenu();
         return;
      }
   }
}

/** Right-pointing caret marking a row that opens a submenu. */
const CHEVRON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">' +
   '<path d="M5.5 2.5 11 8l-5.5 5.5-1-1L8.9 8 4.5 3.5z"/></svg>';

function createItem(label: string, sublabel: string, isParent: boolean): HTMLButtonElement {
   const item = document.createElement('button');
   item.type = 'button';
   item.className = isParent ? 'mix-tools-menu-item mix-tools-menu-item--parent' : 'mix-tools-menu-item';
   item.setAttribute('role', 'menuitem');
   item.tabIndex = -1; // Roving tabindex: the arrow keys move focus, Tab doesn't.
   if (isParent) {
      item.setAttribute('aria-haspopup', 'menu');
      item.setAttribute('aria-expanded', 'false');
   }
   // Every label is a hard-coded constant — nothing user-supplied reaches this markup.
   item.innerHTML = `<span class="mix-tools-menu-item-label">${label}</span>` +
      `<span class="mix-tools-menu-item-sub">${sublabel}</span>` +
      (isParent ? `<span class="mix-tools-menu-item-chevron" aria-hidden="true">${CHEVRON}</span>` : '');
   return item;
}

function isDisabled(item: HTMLElement): boolean {
   return item.getAttribute('aria-disabled') === 'true';
}

/**
 * Grey out a row. It stays focusable (as ARIA recommends for disabled menu items), so
 * keyboard users still reach it and hear why it's unavailable.
 */
function disableItem(item: HTMLElement, sublabel: string): void {
   item.setAttribute('aria-disabled', 'true');
   item.classList.add('mix-tools-menu-item--disabled');
   const sub = item.querySelector('.mix-tools-menu-item-sub');
   if (sub) sub.textContent = sublabel;
   if (openParent === item) closeSubmenu();
}

function positionSubmenu(parent: HTMLElement, submenu: HTMLElement): void {
   const root = parent.closest('.mix-tools-menu');
   const rootRect = (root ?? parent).getBoundingClientRect();
   const parentRect = parent.getBoundingClientRect();
   const { offsetWidth: width, offsetHeight: height } = submenu;

   // Prefer opening to the right of the whole menu, flipping to its left when that won't
   // fit. The menu is right-aligned to a button near the window edge, so the flip is the
   // common case rather than the exception.
   let left = rootRect.right - SUBMENU_OVERLAP;
   if (left + width > window.innerWidth - EDGE_MARGIN) left = rootRect.left - width + SUBMENU_OVERLAP;
   left = Math.max(EDGE_MARGIN, Math.min(left, window.innerWidth - width - EDGE_MARGIN));

   // Line the first submenu row up with its parent row, then keep the box fully on screen.
   const top = Math.max(
      EDGE_MARGIN,
      Math.min(parentRect.top - MENU_PADDING, window.innerHeight - height - EDGE_MARGIN),
   );

   submenu.style.left = `${left}px`;
   submenu.style.top = `${top}px`;
}

function openSubmenu(parent: HTMLElement, entry: MenuEntry, focusFirst: boolean): void {
   cancelClose();
   if (isDisabled(parent)) return closeSubmenu();

   if (openParent === parent) {
      const existing = document.getElementById(SUBMENU_ID);
      if (focusFirst && existing) rows(existing)[0]?.focus({ preventScroll: true });
      return;
   }
   closeSubmenu();

   const submenu = document.createElement('div');
   submenu.id = SUBMENU_ID;
   submenu.className = 'mix-tools-menu mix-tools-menu--submenu';
   submenu.setAttribute('role', 'menu');

   for (const leaf of entry.items) {
      const item = createItem(leaf.label, leaf.sublabel, false);
      item.addEventListener('click', () => {
         closeMenu();
         leaf.run();
      });
      submenu.appendChild(item);
   }

   submenu.addEventListener('mouseenter', cancelClose);
   submenu.addEventListener('mouseleave', scheduleClose);

   // Appended to the body rather than nested inside the root menu: the root is a fixed,
   // rounded, animated box, so a nested child would inherit its transform and risk being
   // clipped. Coming later in DOM order also paints it above the root at the same z-index.
   document.body.appendChild(submenu);
   positionSubmenu(parent, submenu);

   parent.setAttribute('aria-expanded', 'true');
   parent.classList.add('mix-tools-menu-item--open');
   openParent = parent;

   if (focusFirst) rows(submenu)[0]?.focus({ preventScroll: true });
}

function openMenu(anchor: HTMLElement, fromKeyboard: boolean): void {
   if (document.getElementById(MENU_ID)) return closeMenu();
   keyboardOpened = fromKeyboard;

   const menu = document.createElement('div');
   menu.id = MENU_ID;
   menu.className = 'mix-tools-menu';
   menu.setAttribute('role', 'menu');

   const uri = getCurrentPlaylistUri();
   const editable = uri ? canModify(uri) : Promise.resolve(true);

   for (const entry of ACTIONS) {
      const item = createItem(entry.label, entry.sublabel, true);
      item.addEventListener('mouseenter', () => openSubmenu(item, entry, false));
      item.addEventListener('mouseleave', scheduleClose);
      // A destination row has no sort of its own to run, so clicking it opens the submenu
      // — otherwise pointer users who click instead of hovering would be stuck.
      item.addEventListener('click', (e) => {
         e.stopPropagation();
         openSubmenu(item, entry, true);
      });
      menu.appendChild(item);

      // The permission lookup is async, so the row renders enabled and is greyed out once
      // it resolves (near-instantly, the metadata is cached) — unless the menu is gone by then.
      const { requiresEdit } = entry;
      if (requiresEdit) {
         void editable.then((ok) => {
            if (!ok && item.isConnected) disableItem(item, requiresEdit);
         });
      }
   }

   document.body.appendChild(menu);

   const rect = anchor.getBoundingClientRect();
   // Right-align the menu to the button, opening downwards.
   menu.style.top = `${rect.bottom + 4}px`;
   menu.style.left = `${Math.max(EDGE_MARGIN, rect.right - menu.offsetWidth)}px`;

   if (keyboardOpened) rows(menu)[0]?.focus({ preventScroll: true });

   // Defer so this same click doesn't immediately close the menu.
   setTimeout(() => {
      document.addEventListener('click', onOutsideClick, true);
      document.addEventListener('keydown', onKeydown, true);
      // Both menus are fixed-position, so they'd otherwise drift away from the button.
      window.addEventListener('resize', closeMenu);
      window.addEventListener('scroll', closeMenu, true);
   }, 0);
}

/** Metronome-ish glyph so the button reads as "tempo" at a glance. */
const ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">' +
   '<path d="M10.4 1H5.6L2 15h12L10.4 1zm-1.2 1.5 1 3.9-3.9 2.3.9-6.2h2zM4.7 11.2l4.9-2.9.9 3.6-6.2.1.4-.8z"/>' +
   '</svg>';

const IDLE_HTML = `${ICON}<span>BPM</span>`;
const IDLE_LABEL = 'Sort by BPM or key';

export function createBpmButton(): HTMLButtonElement {
   const button = document.createElement('button');
   button.id = BUTTON_ID;
   button.className = 'mix-tools-button';
   button.type = 'button';
   button.setAttribute('aria-label', IDLE_LABEL);
   button.setAttribute('aria-haspopup', 'menu');
   button.setAttribute('title', IDLE_LABEL);
   button.innerHTML = IDLE_HTML;
   button.addEventListener('click', (e) => {
      e.stopPropagation();
      // A click synthesized by Enter/Space on the button reports detail 0.
      openMenu(button, e.detail === 0);
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
      button.classList.remove('mix-tools-button--busy');
      button.innerHTML = IDLE_HTML;
      button.setAttribute('aria-label', IDLE_LABEL);
   } else {
      button.disabled = true;
      button.classList.add('mix-tools-button--busy');
      button.innerHTML = `${ICON}<span>${label}</span>`;
      button.setAttribute('aria-label', `Sorting playlist… ${label}`);
   }
}
