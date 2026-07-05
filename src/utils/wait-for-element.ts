/**
 * Resolve when an element matching `selector` exists in the DOM.
 * Uses a MutationObserver because Spotify mounts views asynchronously.
 * Resolves to `null` if the timeout elapses first (0 = wait forever).
 */
export function waitForElement(selector: string, timeoutMs = 10000): Promise<HTMLElement | null> {
   const existing = document.querySelector<HTMLElement>(selector);
   if (existing) return Promise.resolve(existing);

   return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const observer = new MutationObserver(() => {
         const el = document.querySelector<HTMLElement>(selector);
         if (el) {
            observer.disconnect();
            if (timer) clearTimeout(timer);
            resolve(el);
         }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      if (timeoutMs > 0) {
         timer = setTimeout(() => {
            observer.disconnect();
            resolve(document.querySelector<HTMLElement>(selector));
         }, timeoutMs);
      }
   });
}

/** Return the first element matching any of the candidate selectors, or null. */
export function queryFirst<T extends HTMLElement = HTMLElement>(root: ParentNode, selectors: string[]): T | null {
   for (const selector of selectors) {
      const el = root.querySelector<T>(selector);
      if (el) return el;
   }
   return null;
}
