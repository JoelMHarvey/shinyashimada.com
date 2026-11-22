/* ==========================================================================
   Whether a Postgres connection uses TLS, decided from the address alone.
   Imports no driver, so it is testable without a database.

   Three kinds of address:

   - this machine (localhost, 127.0.0.1, ::1), a bare name with no dot in it
     (a container on the same private Docker network, such as "postgres"),
     or an address that says sslmode=disable: no TLS. The traffic never
     leaves the machine.
   - anything else: TLS, and the server's certificate is checked against
     Node's trust store. A hosted database whose certificate comes from a
     private authority needs that authority in NODE_EXTRA_CA_CERTS.

   There is no setting that keeps TLS and skips the check. Encryption to a
   server nobody has identified protects against nothing that matters.

   The driver also reads sslmode from the address, and its reading wins over
   the `ssl` option: "sslmode=no-verify" there would switch the check off.
   So callers pass connectionFor(url), which takes sslmode out of the address
   and leaves this file's answer as the only one.
   ========================================================================== */

export function sslFor(url) {
  let host = '';
  let mode = '';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    mode = (u.searchParams.get('sslmode') || '').toLowerCase();
  } catch {
    // Not an address this can read: treat it as remote and check the certificate.
    return { rejectUnauthorized: true };
  }
  if (mode === 'disable') return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (host && !host.includes('.') && !host.includes(':')) return false;
  return { rejectUnauthorized: true };
}

/** What to hand to pg's Pool or Client: the address without sslmode, and the TLS decision. */
export function connectionFor(url) {
  const ssl = sslFor(url);
  let connectionString = url;
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('uselibpqcompat');
    connectionString = u.toString();
  } catch {
    // Left as it is; the driver will say what is wrong with it.
  }
  return { connectionString, ssl };
}
