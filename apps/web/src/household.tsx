// The household everyone signed in shares (people, roles, the currency), loaded once and reloaded after a change.
import { createContext, useContext } from 'react';
import type { Household, Person } from './api';

export interface HouseholdCtx { household: Household; reload: () => Promise<void> }
export const HouseholdContext = createContext<HouseholdCtx | null>(null);

export function useHousehold(): HouseholdCtx & { me: Person; name: (id: string) => string; person: (id: string) => Person | undefined } {
  const ctx = useContext(HouseholdContext);
  if (!ctx) throw new Error('no household');
  const person = (id: string) => ctx.household.people.find((p) => p.id === id);
  return { ...ctx, me: ctx.household.me, person, name: (id) => (id === ctx.household.me.id ? 'You' : person(id)?.name ?? 'Someone') };
}

export const roleLabel = (p: Pick<Person, 'role'>) => ({ admin: 'Admin', adult: 'Grown-up', kid: 'Kid' })[p.role];
