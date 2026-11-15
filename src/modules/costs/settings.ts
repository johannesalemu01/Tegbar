import { defineSetting } from '../../core/services/settings.js';

/** Currencies people may record. ETB only unless you add more. */
export const S_CURRENCIES = defineSetting<string[]>({
  key: 'cost_currencies', scope: 'workspace', default: ['ETB'],
  validate: (v): v is string[] => Array.isArray(v) && v.length > 0 && v.length <= 10 && v.every((c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c)),
});
/** Spends above this (in the project's reporting currency, minor units) need the other person's approval. Null = off. */
export const S_SPEND_THRESHOLD = defineSetting<number | null>({
  key: 'spend_approval_threshold', scope: 'workspace', default: null,
  validate: (v): v is number | null => v === null || (Number.isSafeInteger(v) && (v as number) > 0),
});
/** Day of month (1–28) when last month's statement is sent. */
export const S_STATEMENT_DAY = defineSetting<number>({
  key: 'statement_day', scope: 'workspace', default: 1,
  validate: (v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 28,
});
/** Reporting currency per project (for converted totals and budgets). */
export const S_REPORTING_CURRENCY = defineSetting<string>({
  key: 'reporting_currency', scope: 'project', default: 'ETB', validate: (v): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v),
});

export const DEFAULT_CATEGORIES: { slug: string; name: string; aliases: string[] }[] = [
  { slug: 'hosting', name: 'Hosting & servers', aliases: ['server', 'servers', 'vps', 'cloud', 'aws', 'domain', 'hosting'] },
  { slug: 'sms-maps', name: 'SMS & maps', aliases: ['sms', 'maps', 'map', 'otp', 'geocoding'] },
  { slug: 'tools', name: 'Tools & subscriptions', aliases: ['tools', 'tool', 'subscription', 'subscriptions', 'saas', 'software'] },
  { slug: 'legal', name: 'Legal & registration', aliases: ['legal', 'registration', 'license', 'licence', 'lawyer', 'notary', 'tin'] },
  { slug: 'marketing', name: 'Marketing', aliases: ['marketing', 'ads', 'ad', 'promo', 'flyers', 'social'] },
  { slug: 'travel', name: 'Travel', aliases: ['travel', 'transport', 'taxi', 'ride', 'fuel', 'flight'] },
  { slug: 'equipment', name: 'Equipment', aliases: ['equipment', 'hardware', 'laptop', 'phone', 'device'] },
  { slug: 'other', name: 'Other', aliases: ['other', 'misc'] },
];
