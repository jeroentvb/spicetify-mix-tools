import type { ReactNode } from 'react';
import ReactDOM from 'react-dom';
import type * as ReactDOMClient from 'react-dom/client';

// spicetify-creator maps `react-dom` onto Spotify's own ReactDOM, which bundles the
// `react-dom/client` API (`createRoot`) on the same object. That subpath has no global to
// map onto, so reach `createRoot` through the main export instead.
const { createRoot } = ReactDOM as unknown as typeof ReactDOMClient;

/** Every React root we own, keyed by the host element it renders into. */
const roots = new Map<Element, ReactDOMClient.Root>();

/** Render `node` into `host`, a container element we created and placed in Spotify's DOM. */
export function mount(host: Element, node: ReactNode): void {
   const root = createRoot(host);
   root.render(node);
   roots.set(host, root);
}

/** Unmount whatever we rendered into `host` (portals included) and take it out of the DOM. */
export function unmount(host: Element | null): void {
   if (!host) return;
   roots.get(host)?.unmount();
   roots.delete(host);
   host.remove();
}

/**
 * Unmount roots whose host Spotify has thrown away while re-rendering. Otherwise they'd
 * leak, along with any menu or popup they portaled into `<body>`.
 */
export function sweepDetached(): void {
   for (const [host, root] of roots) {
      if (host.isConnected) continue;
      root.unmount();
      roots.delete(host);
   }
}
