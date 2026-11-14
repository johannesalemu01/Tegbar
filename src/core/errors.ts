import type { MessageKey, MessageParams } from './i18n/index.js';

/**
 * An expected, user-facing failure. Handlers render `key` through i18n so the
 * user always learns what to do next. Anything that is not a DomainError is a
 * bug and goes to the critical-error path.
 */
export class DomainError<K extends MessageKey = MessageKey> extends Error {
  readonly key: K;
  readonly params: MessageParams<K>;
  constructor(key: K, ...params: MessageParams<K> extends [] ? [] : [MessageParams<K>[0]]) {
    super(String(key));
    this.key = key;
    this.params = params as unknown as MessageParams<K>;
  }
}

export class ForbiddenError extends DomainError<'error.forbidden'> {
  constructor() {
    super('error.forbidden');
  }
}

export class NotFoundError extends DomainError<'error.not_found'> {
  constructor() {
    super('error.not_found');
  }
}
