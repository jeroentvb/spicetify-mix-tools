import React, { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import {
   sortReorderByBpm,
   sortReorderByKey,
   sortToNewPlaylistByBpm,
   sortToNewPlaylistByKey,
} from '../services/actions';
import { getCurrentPlaylistUri } from '../services/current-uri';
import { canModify } from '../services/playlist';
import { openAutomixDialog } from './automix-dialog';

const BUTTON_ID = 'mix-tools-bpm-button';

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
      items: [
         ...modeLeaves(sortReorderByBpm, sortReorderByKey),
         {
            label: 'Improved automix',
            sublabel: 'Harmonic order + longer transitions',
            run: () => void openAutomixDialog(),
         },
      ],
      requiresEdit: 'Only for playlists you own',
   },
   {
      label: 'Sort into new playlist',
      sublabel: 'Leaves the original untouched',
      items: modeLeaves(sortToNewPlaylistByBpm, sortToNewPlaylistByKey),
   },
];

/**
 * Progress of a running sort, shown on the button. Kept outside the component so the
 * sort (which doesn't know about React) can drive it, and so it survives Spotify
 * re-rendering the action bar and us re-injecting the button mid-sort.
 */
let busyLabel: string | null = null;
const busyListeners = new Set<() => void>();

function subscribeBusy(listener: () => void): () => void {
   busyListeners.add(listener);
   return () => {
      busyListeners.delete(listener);
   };
}

/**
 * Reflect work-in-progress on the button. Pass a short label (e.g. "42%") to show
 * a busy/disabled state, or `null` to restore the idle button.
 */
export function setButtonBusy(label: string | null): void {
   busyLabel = label;
   busyListeners.forEach((listener) => listener());
}

/** The focusable rows of a menu, in visual order. */
function rows(menu: Element | null): HTMLElement[] {
   return menu ? Array.from(menu.querySelectorAll<HTMLElement>('.mix-tools-menu-item')) : [];
}

function focusRow(row: HTMLElement | null | undefined): void {
   row?.focus({ preventScroll: true });
}

function moveFocus(menu: Element, delta: number): void {
   const list = rows(menu);
   if (list.length === 0) return;

   const current = list.indexOf(document.activeElement as HTMLElement);
   if (current === -1) return focusRow(list[delta > 0 ? 0 : list.length - 1]);
   focusRow(list[(current + delta + list.length) % list.length]);
}

/** Right-pointing caret marking a row that opens a submenu. */
function Chevron() {
   return (
      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
         <path d="M5.5 2.5 11 8l-5.5 5.5-1-1L8.9 8 4.5 3.5z" />
      </svg>
   );
}

/** Metronome-ish glyph so the button reads as "tempo" at a glance. */
function MetronomeIcon() {
   return (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
         <path d="M10.4 1H5.6L2 15h12L10.4 1zm-1.2 1.5 1 3.9-3.9 2.3.9-6.2h2zM4.7 11.2l4.9-2.9.9 3.6-6.2.1.4-.8z" />
      </svg>
   );
}

interface MenuItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
   label: string;
   sublabel: string;
   /** Set on rows that expand into a submenu: whether that submenu is currently open. */
   expanded?: boolean;
   /**
    * Greys the row out. It stays focusable (as ARIA recommends for disabled menu items),
    * so keyboard users still reach it and hear why it's unavailable.
    */
   disabled?: boolean;
   buttonRef?: React.Ref<HTMLButtonElement>;
}

function MenuItem({ label, sublabel, expanded, disabled, buttonRef, ...rest }: MenuItemProps) {
   const isParent = expanded !== undefined;
   const className = [
      'mix-tools-menu-item',
      isParent && 'mix-tools-menu-item--parent',
      expanded && 'mix-tools-menu-item--open',
      disabled && 'mix-tools-menu-item--disabled',
   ].filter(Boolean).join(' ');

   return (
      <button
         {...rest}
         ref={buttonRef}
         type="button"
         className={className}
         role="menuitem"
         // Roving tabindex: the arrow keys move focus, Tab doesn't.
         tabIndex={-1}
         aria-haspopup={isParent ? 'menu' : undefined}
         aria-expanded={expanded}
         aria-disabled={disabled || undefined}
      >
         <span className="mix-tools-menu-item-label">{label}</span>
         <span className="mix-tools-menu-item-sub">{sublabel}</span>
         {isParent && <span className="mix-tools-menu-item-chevron" aria-hidden="true"><Chevron /></span>}
      </button>
   );
}

interface SubmenuProps {
   entry: MenuEntry;
   parent: HTMLElement;
   focusFirst: boolean;
   containerRef: React.RefObject<HTMLDivElement>;
   onPick: (leaf: MenuLeaf) => void;
   onMouseEnter: () => void;
   onMouseLeave: () => void;
}

function Submenu({ entry, parent, focusFirst, containerRef, onPick, onMouseEnter, onMouseLeave }: SubmenuProps) {
   useLayoutEffect(() => {
      const submenu = containerRef.current;
      if (!submenu) return;

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

      if (focusFirst) focusRow(rows(submenu)[0]);
   }, []);

   // Portaled to the body rather than nested inside the root menu: the root is a fixed,
   // rounded, animated box, so a nested child would inherit its transform and risk being
   // clipped. Mounting after the root also paints it above the root at the same z-index.
   return createPortal(
      <div
         ref={containerRef}
         className="mix-tools-menu mix-tools-menu--submenu"
         role="menu"
         onMouseEnter={onMouseEnter}
         onMouseLeave={onMouseLeave}
      >
         {entry.items.map((leaf) => (
            <MenuItem key={leaf.label} label={leaf.label} sublabel={leaf.sublabel} onClick={() => onPick(leaf)} />
         ))}
      </div>,
      document.body,
   );
}

/** Whether the user can edit the current playlist. Optimistically true until we know. */
function useCanEdit(): boolean {
   const [editable, setEditable] = useState(true);

   useEffect(() => {
      const uri = getCurrentPlaylistUri();
      if (!uri) return;

      // The lookup is near-instant (the metadata is cached), so the row only briefly
      // renders enabled before it's greyed out.
      let live = true;
      void canModify(uri).then((ok) => {
         if (live) setEditable(ok);
      });
      return () => {
         live = false;
      };
   }, []);

   return editable;
}

interface MenuProps {
   anchor: HTMLElement;
   /**
    * Whether the menu was opened from the keyboard. Only then do we move focus into it:
    * stealing focus on a mouse click can scroll Spotify's virtualized tracklist, and leaves
    * a stray focus ring on the first row.
    */
   fromKeyboard: boolean;
   onClose: () => void;
}

function Menu({ anchor, fromKeyboard, onClose }: MenuProps) {
   const menuRef = useRef<HTMLDivElement>(null);
   const submenuRef = useRef<HTMLDivElement>(null);
   const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
   const closeTimer = useRef<ReturnType<typeof setTimeout>>();
   const editable = useCanEdit();

   /** The parent row whose submenu is open, if any. Only ever one at a time. */
   const [open, setOpen] = useState<{ index: number; focusFirst: boolean } | null>(null);

   const isDisabled = (index: number) => !editable && ACTIONS[index]?.requiresEdit !== undefined;
   // A row that becomes disabled while its submenu is open loses the submenu.
   const openIndex = open && !isDisabled(open.index) ? open.index : null;

   const cancelClose = useCallback(() => {
      clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
   }, []);

   const closeSubmenu = useCallback(() => {
      cancelClose();
      setOpen(null);
   }, [cancelClose]);

   const scheduleClose = useCallback(() => {
      cancelClose();
      closeTimer.current = setTimeout(closeSubmenu, SUBMENU_CLOSE_DELAY);
   }, [cancelClose, closeSubmenu]);

   useEffect(() => cancelClose, [cancelClose]);

   function openSubmenu(index: number, focusFirst: boolean): void {
      cancelClose();
      if (isDisabled(index)) return closeSubmenu();

      if (openIndex === index) {
         if (focusFirst) focusRow(rows(submenuRef.current)[0]);
         return;
      }
      setOpen({ index, focusFirst });
   }

   /** Close the submenu and put focus back on the row that opened it. */
   function leaveSubmenu(): void {
      if (openIndex !== null) focusRow(rowRefs.current[openIndex]);
      closeSubmenu();
   }

   function onKeydown(e: KeyboardEvent): void {
      const menu = menuRef.current;
      if (!menu) return;

      const submenu = submenuRef.current;
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
               onClose();
               anchor.focus({ preventScroll: true });
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
            onClose();
            return;
         }
      }
   }

   // The document listener is registered once, so route it to this render's handler.
   const keydownRef = useRef(onKeydown);
   keydownRef.current = onKeydown;

   useLayoutEffect(() => {
      const menu = menuRef.current;
      if (!menu) return;

      const rect = anchor.getBoundingClientRect();
      // Right-align the menu to the button, opening downwards.
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.left = `${Math.max(EDGE_MARGIN, rect.right - menu.offsetWidth)}px`;

      if (fromKeyboard) focusRow(rowRefs.current[0]);
   }, []);

   useEffect(() => {
      const onOutsideClick = (e: MouseEvent) => {
         const target = e.target as Node;
         const inside = [menuRef.current, submenuRef.current, anchor].some((el) => el?.contains(target));
         if (!inside) onClose();
      };
      const onKey = (e: KeyboardEvent) => keydownRef.current(e);

      // Defer so the click that opened the menu doesn't immediately close it.
      const timer = setTimeout(() => {
         document.addEventListener('click', onOutsideClick, true);
         document.addEventListener('keydown', onKey, true);
         // Both menus are fixed-position, so they'd otherwise drift away from the button.
         window.addEventListener('resize', onClose);
         window.addEventListener('scroll', onClose, true);
      }, 0);

      return () => {
         clearTimeout(timer);
         document.removeEventListener('click', onOutsideClick, true);
         document.removeEventListener('keydown', onKey, true);
         window.removeEventListener('resize', onClose);
         window.removeEventListener('scroll', onClose, true);
      };
   }, [anchor, onClose]);

   const openEntry = openIndex !== null ? ACTIONS[openIndex] : undefined;
   const openParent = openIndex !== null ? rowRefs.current[openIndex] : null;

   return (
      <>
         <div ref={menuRef} className="mix-tools-menu" role="menu">
            {ACTIONS.map((entry, index) => {
               const disabled = isDisabled(index);
               return (
                  <MenuItem
                     key={entry.label}
                     buttonRef={(el) => {
                        rowRefs.current[index] = el;
                     }}
                     label={entry.label}
                     sublabel={disabled && entry.requiresEdit ? entry.requiresEdit : entry.sublabel}
                     expanded={openIndex === index}
                     disabled={disabled}
                     onMouseEnter={() => openSubmenu(index, false)}
                     onMouseLeave={scheduleClose}
                     // A destination row has no sort of its own to run, so clicking it opens the
                     // submenu — otherwise pointer users who click instead of hovering would be stuck.
                     onClick={(e) => {
                        e.stopPropagation();
                        openSubmenu(index, true);
                     }}
                  />
               );
            })}
         </div>
         {openEntry && openParent && (
            <Submenu
               key={openIndex}
               entry={openEntry}
               parent={openParent}
               focusFirst={open?.focusFirst ?? false}
               containerRef={submenuRef}
               onPick={(leaf) => {
                  onClose();
                  leaf.run();
               }}
               onMouseEnter={cancelClose}
               onMouseLeave={scheduleClose}
            />
         )}
      </>
   );
}

const IDLE_LABEL = 'Sort by BPM or key';

export function BpmButton() {
   const busy = useSyncExternalStore(subscribeBusy, () => busyLabel);
   const buttonRef = useRef<HTMLButtonElement>(null);
   const [menu, setMenu] = useState<{ fromKeyboard: boolean } | null>(null);
   const closeMenu = useCallback(() => setMenu(null), []);

   return (
      <>
         <button
            ref={buttonRef}
            id={BUTTON_ID}
            type="button"
            className={busy === null ? 'mix-tools-button' : 'mix-tools-button mix-tools-button--busy'}
            disabled={busy !== null}
            aria-label={busy === null ? IDLE_LABEL : `Sorting playlist… ${busy}`}
            aria-haspopup="menu"
            title={IDLE_LABEL}
            onClick={(e) => {
               e.stopPropagation();
               // A click synthesized by Enter/Space on the button reports detail 0.
               const fromKeyboard = e.detail === 0;
               setMenu((current) => (current ? null : { fromKeyboard }));
            }}
         >
            <MetronomeIcon />
            <span>{busy ?? 'BPM'}</span>
         </button>
         {menu && buttonRef.current && createPortal(
            <Menu anchor={buttonRef.current} fromKeyboard={menu.fromKeyboard} onClose={closeMenu} />,
            document.body,
         )}
      </>
   );
}
