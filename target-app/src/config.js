/*
 * =============================================================================
 *  MyFiat - application configuration
 * =============================================================================
 *  ⚠️  DEMO / CONTROLLED SECURITY TARGET  ⚠️
 *  This file intentionally contains a hard-coded secret so that an automated
 *  security scanner (our "Ari" agent) can discover it. In a real system these
 *  values MUST come from environment variables / a secrets manager and must
 *  never be committed to source control. See SECURITY-NOTES.md (issue #2).
 *
 *  MyFiat is a CLEARLY-FICTIONAL demo bank ("Not a real bank"). All data is
 *  synthetic. Do not deploy with real data or expose to the public internet.
 * =============================================================================
 */

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 8070,
  env: process.env.NODE_ENV || 'production',
  dbPath:
    process.env.MYFIAT_DB ||
    process.env.ACMEPAY_DB ||
    new URL('../data/myfiat.db', import.meta.url).pathname,

  // VULN #2: hard-coded payment-processor secret key committed to source.
  // A real Stripe-style secret key should live in process.env.STRIPE_SECRET_KEY.
  // STRIPE_SECRET_KEY (set by Ari's rotate_secret) overrides the committed key.
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || 'sk_live_51H8xQe2eZvKYlo2CqN4mPZ7bRfWtVj9Xk3MyFiatDEMOxYZ123',
  stripePublishableKey: 'pk_live_51H8xQe2eZvKYlo2CqDEMOpublishable456',

  // Also hard-coded: JWT signing secret (weak + committed).
  // JWT_SECRET (set by Ari's rotate_secret) overrides it; rotating invalidates every session.
  jwtSecret: process.env.JWT_SECRET || 'myfiat-super-secret-signing-key-2021',

  // Toggle between the vulnerable (string-concatenated) query and the safe
  // parameterized query for the transaction search endpoint. The default is
  // the INSECURE path so the SQLi is live for the demo. Set
  // MYFIAT_SAFE_SEARCH=1 (or legacy ACMEPAY_SAFE_SEARCH=1) to use the
  // parameterized "fixed" version.
  safeSearch:
    process.env.MYFIAT_SAFE_SEARCH === '1' ||
    process.env.ACMEPAY_SAFE_SEARCH === '1',
};
