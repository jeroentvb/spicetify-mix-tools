/**
 * Derive the playlist URI for the page the user is currently viewing.
 * Returns null when the current page isn't a (v1/v2) playlist.
 */
export function getCurrentPlaylistUri(): string | null {
   const pathname: string | undefined = Spicetify.Platform?.History?.location?.pathname;
   if (!pathname) return null;

   const segments = pathname.split('/').filter(Boolean);
   const i = segments.indexOf('playlist');
   if (i === -1 || !segments[i + 1]) return null;

   const uri = `spotify:playlist:${segments[i + 1]}`;
   return Spicetify.URI.isPlaylistV1OrV2(uri) ? uri : null;
}
