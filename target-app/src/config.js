/*
 * =============================================================================
 *  MyFiat - application configuration
 * =============================================================================
 *  ⚠️  DEMO / CONTROLLED SECURITY TARGET  ⚠️
 *  This file intentionally contains a hard-coded secret so that an automated
 *  security scanner (our "Ari" agent) can discover it. In a real system these
 *  values MUST come from environment variables / a secrets manager and must
 *  never be committed to source control. See SECURITY-NOTES.md (issue #2).
 * =============================================================================
 */

export const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 8070,
  env: process.env.NODE_ENV || 'production',
  dbPath: process.env.MYFIAT_DB || new URL('../data/myfiat.db', import.meta.url).pathname,

  // VULN #2: hard-coded payment-processor secret key committed to source.
  // A real Stripe-style secret key should live in process.env.STRIPE_SECRET_KEY.
  stripeSecretKey: 'sk_live_51H8xQe2eZvKYlo2CqN4mPZ7bRfWtVj9Xk3MyFiatDEMOxYZ123',
  stripePublishableKey: 'pk_live_51H8xQe2eZvKYlo2CqDEMOpublishable456',

  // Also hard-coded: JWT signing secret (weak + committed).
  jwtSecret: 'myfiat-super-secret-signing-key-2021',

  // Toggle between the vulnerable (string-concatenated) query and the safe
  // parameterized query for the transaction search endpoint. The default is
  // the INSECURE path so the SQLi is live for the demo. Set
  // MYFIAT_SAFE_SEARCH=1 to use the parameterized "fixed" version.
  safeSearch: process.env.MYFIAT_SAFE_SEARCH === '1',
};
