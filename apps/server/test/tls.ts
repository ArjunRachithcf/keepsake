// Certificates for the egress tests, made at test time (PR #12 review, L3: Philobiblos' TLS harness, but no key is ever
// committed): a CA the tests trust, a certificate it signed for the *.test names the tests use, one it signed for
// another name, and one signed by nobody the client trusts. Keys from node:crypto; the X.509 by node-forge (dev only).
import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

export interface Pem { key: string; cert: string }
export interface TestTls { ca: string; good: Pem; wrongName: Pem; untrusted: Pem }

const keys = () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pub: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
};

function cert(o: { cn: string; names?: string[]; isCa?: boolean; pub: string; signKey: string; issuer?: forge.pki.Certificate; serial: string }): forge.pki.Certificate {
  const c = forge.pki.createCertificate();
  c.publicKey = forge.pki.publicKeyFromPem(o.pub);
  c.serialNumber = o.serial;
  c.validity.notBefore = new Date(Date.now() - 86_400_000);
  c.validity.notAfter = new Date(Date.now() + 86_400_000);
  const subject = [{ name: 'commonName', value: o.cn }];
  c.setSubject(subject);
  c.setIssuer(o.issuer ? o.issuer.subject.attributes : subject);
  c.setExtensions([
    { name: 'basicConstraints', cA: Boolean(o.isCa), critical: true },
    { name: 'keyUsage', keyCertSign: Boolean(o.isCa), digitalSignature: true, keyEncipherment: !o.isCa, critical: true },
    ...(o.names ? [{ name: 'extKeyUsage', serverAuth: true }, { name: 'subjectAltName', altNames: o.names.map((value) => ({ type: 2, value })) }] : []),
  ]);
  c.sign(forge.pki.privateKeyFromPem(o.signKey), forge.md.sha256.create());
  return c;
}

let made: TestTls | undefined;
/** Made once per test file. */
export function testTls(names: string[]): TestTls {
  if (made) return made;
  const caKeys = keys();
  const ca = cert({ cn: 'Keepsake test CA', isCa: true, pub: caKeys.pub, signKey: caKeys.key, serial: '01' });
  const leaf = (n: string[], serial: string): Pem => {
    const k = keys();
    return { key: k.key, cert: forge.pki.certificateToPem(cert({ cn: n[0]!, names: n, pub: k.pub, signKey: caKeys.key, issuer: ca, serial })) };
  };
  const other = keys();
  const otherCa = cert({ cn: 'Nobody trusts this', isCa: true, pub: other.pub, signKey: other.key, serial: '09' });
  const u = keys();
  made = {
    ca: forge.pki.certificateToPem(ca),
    good: leaf(names, '02'),
    wrongName: leaf(['elsewhere.test'], '03'),
    untrusted: { key: u.key, cert: forge.pki.certificateToPem(cert({ cn: names[0]!, names, pub: u.pub, signKey: other.key, issuer: otherCa, serial: '04' })) },
  };
  return made;
}
