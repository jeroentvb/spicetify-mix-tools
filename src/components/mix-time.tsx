import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { HEADER_FULL_TIME } from '../constants/selectors';
import { getCurrentPlaylistUri } from '../services/current-uri';
import { getMixStats, isMixEnabled, type MixStats } from '../services/mix';
import { mount, unmount } from '../utils/mount';
import { queryFirst } from '../utils/wait-for-element';

const LABEL_ID = 'mix-tools-mix-time';

/** Gap kept between the popup and the viewport edge. */
const EDGE_MARGIN = 8;

/**
 * Results per cache key, so Spotify's frequent header re-renders don't refetch every
 * transition. `null` marks a playlist without mix mode.
 */
const cache = new Map<string, Promise<MixStats | null>>();

/**
 * Identifies one computation. The header text changes when tracks are added or removed,
 * and the history key changes on every navigation, so coming back from the mix editor
 * picks up edited transitions.
 */
function cacheKey(uri: string, fullTime: HTMLElement): string {
   const navKey: string = Spicetify.Platform?.History?.location?.key ?? '';
   return `${uri}|${fullTime.textContent ?? ''}|${navKey}`;
}

/** 7445000 → "2:04:05"; under an hour → "40:58". */
function formatClock(ms: number): string {
   const total = Math.max(0, Math.round(ms / 1000));
   const h = Math.floor(total / 3600);
   const m = Math.floor((total % 3600) / 60);
   const s = String(total % 60).padStart(2, '0');
   return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Format like the header's own playtime ("3 hr 43 min", "43 min 12 sec"), using Spotify's
 * locale strings so it matches the client language. Spotify floors to the unit shown.
 */
function formatHeaderDuration(ms: number): string {
   const total = Math.max(0, Math.floor(ms / 1000));
   const h = Math.floor(total / 3600);
   const m = Math.floor((total % 3600) / 60);
   const s = total % 60;

   const unit = (key: string, fallback: string, n: number): string => {
      const text: unknown = Spicetify.Locale?.get?.(`time.${key}.short`, n);
      return typeof text === 'string' && text.includes(String(n)) ? text : `${n} ${fallback}`;
   };

   if (h > 0) return m > 0 ? `${unit('hours', 'hr', h)} ${unit('minutes', 'min', m)}` : unit('hours', 'hr', h);
   return s > 0 ? `${unit('minutes', 'min', m)} ${unit('seconds', 'sec', s)}` : unit('minutes', 'min', m);
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
   return (
      <div className={strong ? 'mix-tools-mix-row mix-tools-mix-row--strong' : 'mix-tools-mix-row'}>
         <span>{label}</span>
         <span>{value}</span>
      </div>
   );
}

interface PopupProps {
   anchor: HTMLElement;
   stats: MixStats;
   onClose: () => void;
}

function Popup({ anchor, stats, onClose }: PopupProps) {
   const popupRef = useRef<HTMLDivElement>(null);

   useLayoutEffect(() => {
      const popup = popupRef.current;
      if (!popup) return;

      const rect = anchor.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - popup.offsetWidth - EDGE_MARGIN);
      popup.style.top = `${rect.bottom + 6}px`;
      popup.style.left = `${Math.max(EDGE_MARGIN, left)}px`;
   }, []);

   useEffect(() => {
      const onOutsideClick = (e: MouseEvent) => {
         const target = e.target as Node;
         const inside = [popupRef.current, anchor].some((el) => el?.contains(target));
         if (!inside) onClose();
      };
      const onKeydown = (e: KeyboardEvent) => {
         if (e.key !== 'Escape') return;
         e.preventDefault();
         e.stopPropagation();
         onClose();
         anchor.focus({ preventScroll: true });
      };

      // Defer so the click that opened the popup doesn't immediately close it.
      const timer = setTimeout(() => {
         document.addEventListener('click', onOutsideClick, true);
         document.addEventListener('keydown', onKeydown, true);
         window.addEventListener('resize', onClose);
         window.addEventListener('scroll', onClose, true);
      }, 0);

      return () => {
         clearTimeout(timer);
         document.removeEventListener('click', onOutsideClick, true);
         document.removeEventListener('keydown', onKeydown, true);
         window.removeEventListener('resize', onClose);
         window.removeEventListener('scroll', onClose, true);
      };
   }, [anchor, onClose]);

   const edited = stats.customTransitions === stats.transitions
      ? `All ${stats.transitions} transitions hand-edited`
      : `${stats.customTransitions} of ${stats.transitions} transitions hand-edited; ` +
         'the rest use Spotify\'s automatic transition';

   return createPortal(
      <div
         ref={popupRef}
         className="mix-tools-menu mix-tools-mix-popup"
         role="dialog"
         aria-label="Mixed playtime breakdown"
      >
         <Row label="Back to back" value={formatClock(stats.rawMs)} />
         <Row label="Intros skipped" value={`−${formatClock(stats.introsSkippedMs)}`} />
         <Row label="Outros skipped" value={`−${formatClock(stats.outrosSkippedMs)}`} />
         <Row label="Transition overlap" value={`−${formatClock(stats.overlapMs)}`} />
         <hr className="mix-tools-mix-divider" />
         <Row label="Mixed" value={formatClock(stats.mixedMs)} strong />
         <p className="mix-tools-mix-note">{edited}</p>
      </div>,
      document.body,
   );
}

/** Circled "i", matching the size of the header text. */
function InfoIcon() {
   return (
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
         <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z" />
         <path d="M7.25 7h1.5v4.5h-1.5zM8 4.25a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z" />
      </svg>
   );
}

/** Rendered into the label span that sits next to the header's playtime. */
function MixTime({ stats }: { stats: MixStats }) {
   const buttonRef = useRef<HTMLButtonElement>(null);
   const [open, setOpen] = useState(false);
   const closePopup = useCallback(() => setOpen(false), []);

   return (
      <>
         <span className="mix-tools-mix-separator" aria-hidden="true">•</span>
         {`${formatHeaderDuration(stats.mixedMs)} mixed`}
         <button
            ref={buttonRef}
            type="button"
            className="mix-tools-mix-info"
            aria-label="Show mixed playtime breakdown"
            aria-haspopup="dialog"
            aria-expanded={open}
            title="Mixed playtime breakdown"
            onClick={(e) => {
               e.stopPropagation();
               setOpen((current) => !current);
            }}
         >
            <InfoIcon />
         </button>
         {open && buttonRef.current && <Popup anchor={buttonRef.current} stats={stats} onClose={closePopup} />}
      </>
   );
}

/**
 * Newer clients style the playtime element itself (Encore text classes) rather than its
 * parent, so copy its classes to match its font and color. Not the legacy
 * `main-entityHeader-*` ones, which `HEADER_FULL_TIME` would then match on our label.
 */
function createLabel(key: string, stats: MixStats, fullTime: HTMLElement): HTMLElement {
   const label = document.createElement('span');
   label.id = LABEL_ID;
   const copied = [...fullTime.classList].filter((name) => !name.startsWith('main-entityHeader'));
   label.className = [...copied, 'mix-tools-mix-time'].join(' ');
   label.dataset.key = key;
   mount(label, <MixTime stats={stats} />);
   return label;
}

/**
 * Keep the mixed playtime next to the header's total playtime on mixed playlists, and
 * absent everywhere else. Called on every (debounced) re-render, so it must be cheap
 * when nothing changed.
 */
export function ensureMixTime(): void {
   const uri = getCurrentPlaylistUri();
   const fullTime = uri ? queryFirst(document, HEADER_FULL_TIME) : null;
   const existing = document.getElementById(LABEL_ID);

   if (!uri || !fullTime) {
      unmount(existing);
      return;
   }

   const key = cacheKey(uri, fullTime);
   if (existing?.dataset.key === key && existing.previousElementSibling === fullTime) return;

   let pending = cache.get(key);
   if (!pending) {
      pending = isMixEnabled(uri)
         .then((mixed) => (mixed ? getMixStats(uri) : null))
         .catch((err) => {
            console.error('[mix-tools] Could not compute mixed playtime', err);
            return null;
         });
      cache.set(key, pending);
   }

   void pending.then((stats) => {
      // The user may have navigated, or the header re-rendered, while this was in flight.
      const current = uri === getCurrentPlaylistUri() ? queryFirst(document, HEADER_FULL_TIME) : null;
      if (!current || cacheKey(uri, current) !== key) return;

      const label = document.getElementById(LABEL_ID);
      if (label?.dataset.key === key && label.previousElementSibling === current) return;

      unmount(label);
      if (stats) current.after(createLabel(key, stats, current));
   });
}
