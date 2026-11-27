// The browser's half of a passkey (WebAuthn) with @simplewebauthn/browser.
import { startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import { api, type AuthSession, type EnrolStart, type SignInStart } from './api';

/** The browser made or used no passkey: closed, refused, or (signing in) none for Keepsake on this device. */
export class PasskeyNotUsed extends Error {}

const friendly = (e: unknown): Error => {
  if (e instanceof WebAuthnError || (e instanceof Error && e.name === 'NotAllowedError')) return new PasskeyNotUsed('The passkey was not used. Try again when you are ready.');
  return e instanceof Error ? e : new Error('Something went wrong.');
};

export const enrolOptions = (token: string, name?: string) =>
  api<EnrolStart>('/auth/enrol/options', { method: 'POST', body: { token, ...(name ? { name } : {}) } });

export async function finishEnrol(start: EnrolStart, label: string): Promise<AuthSession> {
  let response;
  try { response = await startRegistration({ optionsJSON: start.options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'] }); } catch (e) { throw friendly(e); }
  return api<AuthSession>('/auth/enrol/verify', { method: 'POST', body: { challengeId: start.challengeId, response, label } });
}

export async function signIn(): Promise<AuthSession> {
  const start = await api<SignInStart>('/auth/sign-in/options', { method: 'POST' });
  let response;
  try { response = await startAuthentication({ optionsJSON: start.options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'] }); } catch (e) { throw friendly(e); }
  return api<AuthSession>('/auth/sign-in/verify', { method: 'POST', body: { challengeId: start.challengeId, response } });
}
