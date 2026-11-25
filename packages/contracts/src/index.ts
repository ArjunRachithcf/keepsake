// Types generated from contracts/openapi.yaml (`pnpm gen:api`; CI checks they are in sync).
export type { paths, components, operations } from './openapi.gen';
import type { components } from './openapi.gen';

type S = components['schemas'];
export type Health = S['Health'];
export type Role = S['Role'];
export type Person = S['Person'];
export type PersonRef = S['PersonRef'];
export type AuthSession = S['AuthSession'];
export type EnrolStart = S['EnrolStart'];
export type SignInStart = S['SignInStart'];
export type OneTimeLink = S['OneTimeLink'];
export type Household = S['Household'];
export type Passkey = S['Passkey'];
export type Passkeys = S['Passkeys'];
export type Size = S['Size'];
export type Profile = S['Profile'];
export type ProfileInput = S['ProfileInput'];
export type WishState = S['WishState'];
export type Wish = S['Wish'];
export type WishInput = S['WishInput'];
export type WishPatch = S['WishPatch'];
export type Poster = S['Poster'];
export type Recurrence = S['Recurrence'];
export type Celebration = S['Celebration'];
export type CelebrationInput = S['CelebrationInput'];
export type CelebrationPatch = S['CelebrationPatch'];
export type Celebrations = S['Celebrations'];
export type CelebrationPage = S['CelebrationPage'];
export type PersonList = S['PersonList'];
export type PersonPage = S['PersonPage'];
export type Home = S['Home'];

export const MODES = ['homerslab', 'standalone'] as const satisfies readonly Health['mode'][];
export const ROLES = ['admin', 'adult', 'kid'] as const satisfies readonly Role[];
export const POSTERS = ['pine', 'berry', 'night', 'gold'] as const satisfies readonly Poster[];
