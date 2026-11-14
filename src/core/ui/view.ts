import type { Btn } from './keyboard.js';

/** What a handler wants to show. Rendering (send vs edit-in-place) is decided by the Telegram layer. */
export interface View {
  text: string;
  keyboard?: Btn[][];
}
