// Whether Process takes single keys, such as S to skip, on this device. Off by default and offered only on desktop:
// speech input can type a letter that would skip or send an item (WCAG 2.1.4), and a phone has no keyboard. Option or
// Alt with the key works either way. Kept on this device only, like the appearance.

import { useStickyState } from './store';

/** Where it's kept, for an account switch to leave alone. */
export const PROCESS_KEYS_KEY = 'multiscale.processKeys';

export const useProcessKeys = () => useStickyState('processKeys', false);
