import type { Register } from 'claude-code';

import { destructiveBash } from './rules/destructive-bash';
import { secretReads } from './rules/secret-reads';

export const register: Register = (on, options) => {
  // Registered first, so outermost: a secret read is denied before a hold is offered.
  if (options['secret_reads'] !== false) secretReads(on, options);
  if (options['destructive_bash'] !== false) destructiveBash(on, options);
};
