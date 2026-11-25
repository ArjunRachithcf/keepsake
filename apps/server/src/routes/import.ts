// The one-time sheet import (ADR 0005): admins only (checked in the facade and the domain too). The file comes in the
// request body, is read, and is gone with the request: the dry run writes nothing, applying writes only the wishes and
// claims it makes, in one transaction.
import { MAX_CSV, type Data } from '../data';
import { Refused } from '../errors';
import type { Router } from '../router';
import { importInput } from '../validate';

/** The CSV as JSON text: up to MAX_CSV characters, which JSON's escapes can about double. */
const BODY = 2 * MAX_CSV + 64 * 1024;

export function importRoutes(api: Router, data: Data) {
  api.post('/import/dry-run', { bodyLimit: BODY }, (r) => {
    if (data.me(r).role !== 'admin') throw new Refused(403, 'admins only');
    return data.imports.dryRun(r, importInput(r.body, MAX_CSV));
  });

  api.post('/import', { bodyLimit: BODY }, (r) => {
    if (data.me(r).role !== 'admin') throw new Refused(403, 'admins only');
    return data.imports.apply(r, importInput(r.body, MAX_CSV));
  });
}
