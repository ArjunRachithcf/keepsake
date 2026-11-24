// Types generated from contracts/openapi.yaml (`pnpm gen:api`; CI checks they are in sync).
export type { paths, components, operations } from './openapi.gen';
import type { components } from './openapi.gen';

export type Health = components['schemas']['Health'];
export const MODES = ['homerslab', 'standalone'] as const satisfies readonly Health['mode'][];
