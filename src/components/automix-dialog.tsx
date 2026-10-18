import React, { useEffect, useId, useRef, useState } from 'react';

import type { BarPreference } from '../services/automix';
import { automixTarget, improvedAutomix } from '../services/actions';
import { mount, unmount } from '../utils/mount';

const STORAGE_KEY = 'mix-tools:automix-bars';

interface Option {
   value: BarPreference;
   label: string;
   sublabel: string;
}

const OPTIONS: Option[] = [
   { value: 'auto', label: 'Auto', sublabel: 'Spotify\'s own top-ranked transition for each pair' },
   { value: 16, label: '16 bars', sublabel: 'Long blends. Falls back to 8 where Spotify rates 16 poorly' },
   { value: 8, label: '8 bars', sublabel: 'Spotify\'s usual length. Falls back to 4' },
   { value: 4, label: '4 bars', sublabel: 'Quick blends. Falls back to 2' },
];

/** The last choice, so the dialog opens on it. Storage can be unavailable, hence the guards. */
function loadPreference(): BarPreference {
   try {
      const stored = localStorage.getItem(STORAGE_KEY);
      const match = OPTIONS.find((option) => String(option.value) === stored);
      if (match) return match.value;
   } catch {
      // Fall through to the default.
   }
   return 'auto';
}

function savePreference(value: BarPreference): void {
   try {
      localStorage.setItem(STORAGE_KEY, String(value));
   } catch {
      // Not remembering the choice is fine.
   }
}

/** Every element Tab can reach inside `root`, in order. */
function focusables(root: HTMLElement): HTMLElement[] {
   return Array.from(root.querySelectorAll<HTMLElement>('input:checked, button:not(:disabled)'));
}

interface DialogProps {
   onConfirm: (preference: BarPreference) => void;
   onClose: () => void;
}

function AutomixDialog({ onConfirm, onClose }: DialogProps) {
   const [preference, setPreference] = useState<BarPreference>(loadPreference);
   const dialogRef = useRef<HTMLFormElement>(null);
   const titleId = useId();
   const descriptionId = useId();

   useEffect(() => {
      dialogRef.current?.querySelector<HTMLElement>('input:checked')?.focus();

      // Capture phase, so the client's global shortcuts (Space = play/pause) never see keys
      // typed into the dialog. Default actions (moving between radios, submitting) still run.
      const onKeydown = (e: KeyboardEvent) => {
         const dialog = dialogRef.current;
         if (!dialog) return;
         e.stopPropagation();

         if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
         } else if (e.key === 'Tab') {
            // Keep focus inside the dialog while it's open.
            const list = focusables(dialog);
            const index = list.indexOf(document.activeElement as HTMLElement);
            const next = e.shiftKey
               ? (index <= 0 ? list.length - 1 : index - 1)
               : (index === list.length - 1 ? 0 : index + 1);
            e.preventDefault();
            list[next]?.focus();
         }
      };

      document.addEventListener('keydown', onKeydown, true);
      return () => document.removeEventListener('keydown', onKeydown, true);
   }, [onClose]);

   return (
      <div
         className="mix-tools-backdrop"
         onMouseDown={(e) => {
            if (e.target === e.currentTarget) onClose();
         }}
      >
         <form
            ref={dialogRef}
            className="mix-tools-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            onSubmit={(e) => {
               e.preventDefault();
               savePreference(preference);
               onConfirm(preference);
            }}
         >
            <h2 id={titleId} className="mix-tools-dialog-title">Improved automix</h2>
            <p id={descriptionId} className="mix-tools-dialog-text">
               Reorders this playlist for harmonic mixing and sets the transition between every
               pair of tracks. Which transition length should it go for?
            </p>

            <fieldset className="mix-tools-dialog-options">
               <legend className="mix-tools-visually-hidden">Transition length</legend>
               {OPTIONS.map((option) => (
                  <label
                     key={option.value}
                     className={option.value === preference ? 'mix-tools-option mix-tools-option--checked' : 'mix-tools-option'}
                  >
                     <input
                        type="radio"
                        name="mix-tools-automix-bars"
                        checked={option.value === preference}
                        onChange={() => setPreference(option.value)}
                     />
                     <span className="mix-tools-option-text">
                        <span className="mix-tools-option-label">{option.label}</span>
                        <span className="mix-tools-option-sub">{option.sublabel}</span>
                     </span>
                  </label>
               ))}
            </fieldset>

            <div className="mix-tools-dialog-actions">
               <button type="button" className="mix-tools-dialog-button" onClick={onClose}>Cancel</button>
               <button type="submit" className="mix-tools-dialog-button mix-tools-dialog-button--primary">
                  Mix playlist
               </button>
            </div>
         </form>
      </div>
   );
}

/**
 * Ask which transition length to go for, then run the improved automix on the current
 * playlist. Checks the playlist can be mixed first, so the user isn't asked for nothing.
 */
export async function openAutomixDialog(): Promise<void> {
   const uri = await automixTarget();
   if (!uri) return;

   // Its own root on <body>: the dialog isn't tied to the action bar, which Spotify re-renders.
   const host = document.createElement('div');
   host.className = 'mix-tools-root';
   document.body.append(host);

   const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
   const close = () => {
      unmount(host);
      returnFocus?.focus({ preventScroll: true });
   };

   mount(host, (
      <AutomixDialog
         onClose={close}
         onConfirm={(preference) => {
            close();
            void improvedAutomix(uri, preference);
         }}
      />
   ));
}
