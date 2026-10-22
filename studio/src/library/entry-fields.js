import { invalid, text } from './registry.js';

export const ENTRY_FILTER_VALUES = {
  availability: ['unverified', 'observed-available', 'offline', 'missing', 'corrupt'],
  reviewStatus: ['candidate', 'accepted', 'rejected', 'unknown'],
  adoptionStatus: ['adopted', 'not-adopted', 'unknown'],
  sourceType: ['source', 'derived', 'unknown'],
};
export function validateEntryFilters(value) {
  if (value.status !== undefined) text(value.status);
  for (const [field, allowed] of Object.entries(ENTRY_FILTER_VALUES))
    if (value[field] !== undefined && !allowed.includes(value[field])) invalid();
}
