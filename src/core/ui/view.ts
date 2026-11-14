import type { Btn } from './keyboard.js';

/** What a handler wants to show. Rendering (send vs edit-in-place) is decided by the Telegram layer. */
export interface Venue {
  latitude: number;
  longitude: number;
  title: string;
  address: string;
}

export interface View {
  text: string;
  keyboard?: Btn[][];
  /** Sent as a Telegram venue right after the text (opens in a maps app). */
  venue?: Venue;
}
