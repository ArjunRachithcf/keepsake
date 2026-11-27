// Family (spec §4): the grown-ups and the kids (with how many wishes wait for you), notifications on this device, and
// standalone your passkeys and signing out. Admins reach the Household from here (and from the sidebar).
import { useEffect, useState } from 'react';
import { api, type Home, type Person } from '../api';
import { roleLabel, useHousehold } from '../household';
import { Icon } from '../icons';
import { AccountButton, You } from '../account';
import { PushSwitch } from '../notify';
import { Avatar, Group, Link, PageHead, TopLine } from '../ui';

export function Family({ onSignOut }: { onSignOut?: () => void }) {
  const { household, me, person } = useHousehold();
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  useEffect(() => {
    api<Home>('/home').then((h) => {
      const n: Record<string, number> = {};
      for (const w of h.toApprove) n[w.personId] = (n[w.personId] ?? 0) + 1;
      setWaiting(n);
    }, () => undefined);
  }, []);
  const grownUps = household.people.filter((p) => p.role !== 'kid');
  const kids = household.people.filter((p) => p.role === 'kid');
  const approvers = (p: Person) => {
    const ms = p.managers.map((m) => (m === me.id ? 'you' : person(m)?.name)).filter(Boolean) as string[];
    if (!ms.length) return 'the admins approve their wishes';
    return `${ms.length === 1 ? ms[0] : `${ms.slice(0, -1).join(', ')} and ${ms.at(-1)}`} ${ms.length === 1 && ms[0] !== 'you' ? 'approves' : 'approve'} ${p.name}’s wishes`;
  };
  const row = (p: Person) => (
    <li key={p.id} data-row={p.id}>
      <Link to={`/family/${p.id}`} className="row row-link">
        <span className="row-lead"><Avatar id={p.id} name={p.name} /></span>
        <span className="row-main">
          <span className="row-title">{p.id === me.id ? `${p.name} (you)` : p.name}</span>
          <span className="row-sub wrap">{roleLabel(p)}{p.role === 'kid' ? ` · ${approvers(p)}` : ''}</span>
        </span>
        {waiting[p.id] ? <span className="pill pill-orange">{waiting[p.id]} to approve</span> : null}
        <Icon name="chevronRight" className="icon row-chev" />
      </Link>
    </li>
  );
  return (
    <>
      <TopLine end={<>{me.role === 'admin' && <Link to="/household" className="topbar-back is-plain"><Icon name="home" />&nbsp;Household</Link>}<AccountButton /></>} />
      <PageHead title="Family" wideSub sub={`${household.people.length} ${household.people.length === 1 ? 'person' : 'people'}. Open someone to see their wishes, ask them something, or keep an idea for them.`}
        actions={me.role === 'admin' ? <Link to="/household" className="btn"><Icon name="home" />Household</Link> : undefined} />
      <div className="ks-two">
        <div>
          <Group title="Grown-ups" lead="md">{grownUps.map(row)}</Group>
          {kids.length > 0 && <Group title="Kids" lead="md" footer="A kid’s new wish waits for a parent before anyone else sees it.">{kids.map(row)}</Group>}
        </div>
        <div>
          <PushSwitch />
          {onSignOut && <You onSignOut={onSignOut} />}
        </div>
      </div>
    </>
  );
}
