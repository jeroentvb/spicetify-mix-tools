import { HEADER_FULL_TIME } from '../constants/selectors';
import { getCurrentPlaylistUri } from '../services/current-uri';
import { getMixStats, isMixEnabled, type MixStats } from '../services/mix';
import { queryFirst } from '../utils/wait-for-element';

const LABEL_ID = 'mix-tools-mix-time';
const POPUP_ID = 'mix-tools-mix-popup';

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

function closePopup(): void {
   document.getElementById(POPUP_ID)?.remove();
   document.removeEventListener('click', onOutsideClick, true);
   document.removeEventListener('keydown', onKeydown, true);
   window.removeEventListener('resize', closePopup);
   window.removeEventListener('scroll', closePopup, true);
}

function onOutsideClick(e: MouseEvent): void {
   const target = e.target as Node;
   const inside = [POPUP_ID, LABEL_ID].some((id) => document.getElementById(id)?.contains(target));
   if (!inside) closePopup();
}

function onKeydown(e: KeyboardEvent): void {
   if (e.key !== 'Escape') return;
   e.preventDefault();
   e.stopPropagation();
   closePopup();
   document.querySelector<HTMLElement>(`#${LABEL_ID} button`)?.focus({ preventScroll: true });
}

function row(label: string, value: string, strong = false): string {
   return `<div class="mix-tools-mix-row${strong ? ' mix-tools-mix-row--strong' : ''}">` +
      `<span>${label}</span><span>${value}</span></div>`;
}

function openPopup(anchor: HTMLElement, stats: MixStats): void {
   if (document.getElementById(POPUP_ID)) return closePopup();

   const popup = document.createElement('div');
   popup.id = POPUP_ID;
   popup.className = 'mix-tools-menu mix-tools-mix-popup';
   popup.setAttribute('role', 'dialog');
   popup.setAttribute('aria-label', 'Mixed playtime breakdown');

   const edited = stats.customTransitions === stats.transitions
      ? `All ${stats.transitions} transitions hand-edited`
      : `${stats.customTransitions} of ${stats.transitions} transitions hand-edited; ` +
         'the rest use Spotify\'s automatic transition';

   // Only numbers and constant labels reach this markup.
   popup.innerHTML =
      row('Back to back', formatClock(stats.rawMs)) +
      row('Intros skipped', `−${formatClock(stats.introsSkippedMs)}`) +
      row('Outros skipped', `−${formatClock(stats.outrosSkippedMs)}`) +
      row('Transition overlap', `−${formatClock(stats.overlapMs)}`) +
      '<hr class="mix-tools-mix-divider">' +
      row('Mixed', formatClock(stats.mixedMs), true) +
      `<p class="mix-tools-mix-note">${edited}</p>`;

   document.body.appendChild(popup);

   const rect = anchor.getBoundingClientRect();
   const left = Math.min(rect.left, window.innerWidth - popup.offsetWidth - EDGE_MARGIN);
   popup.style.top = `${rect.bottom + 6}px`;
   popup.style.left = `${Math.max(EDGE_MARGIN, left)}px`;

   // Defer so this same click doesn't immediately close the popup.
   setTimeout(() => {
      document.addEventListener('click', onOutsideClick, true);
      document.addEventListener('keydown', onKeydown, true);
      window.addEventListener('resize', closePopup);
      window.addEventListener('scroll', closePopup, true);
   }, 0);
}

/** Circled "i", matching the size of the header text. */
const INFO_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">' +
   '<path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8z"/>' +
   '<path d="M7.25 7h1.5v4.5h-1.5zM8 4.25a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8z"/></svg>';

function createLabel(key: string, stats: MixStats): HTMLElement {
   const label = document.createElement('span');
   label.id = LABEL_ID;
   label.className = 'mix-tools-mix-time';
   label.dataset.key = key;
   label.textContent = ` • ${formatHeaderDuration(stats.mixedMs)} mixed`;

   const button = document.createElement('button');
   button.type = 'button';
   button.className = 'mix-tools-mix-info';
   button.setAttribute('aria-label', 'Show mixed playtime breakdown');
   button.setAttribute('aria-haspopup', 'dialog');
   button.title = 'Mixed playtime breakdown';
   button.innerHTML = INFO_ICON;
   button.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopup(button, stats);
   });

   label.appendChild(button);
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
      existing?.remove();
      closePopup();
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

      label?.remove();
      closePopup();
      if (stats) current.after(createLabel(key, stats));
   });
}
