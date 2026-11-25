// What screens keep in this device's local storage, such as a plan in progress, belongs to the account signed in here.
// Erasing it keeps the device's own choices.

import { WHATS_NEW_KEY } from '../../core/whatsNew';
import { APPEARANCE_KEY } from './appearance';
import { PROCESS_KEYS_KEY } from './processKeys';
import { SHOW_COMPLETED_KEY } from './showCompleted';

/** Choices about this device rather than the account, so an account switch or deletion keeps them. */
const DEVICE_KEYS = [APPEARANCE_KEY, SHOW_COMPLETED_KEY, PROCESS_KEYS_KEY, WHATS_NEW_KEY];

/** Erases what screens keep for the account, as when another account signs in here or this one is deleted. */
export function forgetScreenState(): void {
  try {
    const kept = DEVICE_KEYS.map((key) => [key, localStorage.getItem(key)] as const);
    localStorage.clear();
    for (const [key, value] of kept) if (value !== null) localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked, and then holds nothing.
  }
}
