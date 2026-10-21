/**
 * Spotify's DOM/testids are undocumented and change between client versions.
 * Every selector that targets Spotify internals lives here so it's a single
 * place to patch when the client updates. Each entry is a list of candidates,
 * tried in order (see `queryFirst`).
 *
 * The client is localized, so never match on label text (`aria-label`, textContent).
 */

/** The playlist header action bar (Play / Shuffle / … / Search / Sort). */
export const ACTION_BAR = [
   '[data-testid="action-bar-row"]',
   '.main-actionBar-ActionBarRow',
];

/** The "Search in playlist" toggle button. Query within `ACTION_BAR`: the sidebar has a search too. */
export const SEARCH_BUTTON = [
   '[data-testid="search-fields-button"]',
   '.x-filterBox-expandButton',
   '[role="search"] > button',
];

/** The sort / view-options button (opens the sort + list/compact menu). */
export const SORT_BUTTON = [
   '[data-testid="sort-button"]',
   '.x-sortBox-sortDropdown',
   // Spotify 1.3.6: a combobox controlling the "sortboxlist-<uuid>" menu
   '[aria-controls^="sortboxlist-"]',
];

/** The playlist header's total playtime, e.g. "3 hr 43 min". */
export const HEADER_FULL_TIME = [
   '.main-entityHeader-metadataFullTime',
   // Spotify 1.3.6 has only hashed classes; the playtime is the last item of the
   // "57 songs, 3 hr 43 min" group, after its separator. Once our label is inserted
   // after it, it's no longer the last child, so match it by the label too.
   '[data-testid="entity-header"] [data-separator] + span:has(+ #mix-tools-mix-time)',
   '[data-testid="entity-header"] [data-separator] + span:last-child',
];
