/**
 * Spotify's DOM/testids are undocumented and change between client versions.
 * Every selector that targets Spotify internals lives here so it's a single
 * place to patch when the client updates. Each entry is a list of candidates,
 * tried in order (see `queryFirst`).
 */

/** The playlist header action bar (Play / Shuffle / … / Search / Sort). */
export const ACTION_BAR = [
   '[data-testid="action-bar-row"]',
   '.main-actionBar-ActionBarRow',
   '.main-actionBarBackground-background + * [role="toolbar"]',
];

/** The "Search in playlist" toggle button. */
export const SEARCH_BUTTON = [
   'button[data-testid="search-fields-button"]',
   'button[aria-label="Search in playlist"]',
   'button[aria-label*="Search in"]',
];

/** The sort / view-options button (opens the sort + list/compact menu). */
export const SORT_BUTTON = [
   'button[data-testid="sort-button"]',
   'button[aria-label="Sort"]',
   'button[aria-label*="Sort"]',
   // Newer clients label it with the current order, e.g. "Custom order"
   'button[aria-label*="order"]',
];
