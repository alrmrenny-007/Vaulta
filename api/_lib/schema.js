'use strict';
/* Creates the tables on first use (safe to run many times). */
const { tx } = require('./core');

const SQL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  pass_hash text NOT NULL,
  account_number text NOT NULL,
  nickname text NOT NULL DEFAULT 'Main Account',
  theme text NOT NULL DEFAULT 'emerald',
  balance bigint NOT NULL DEFAULT 0 CHECK (balance >= 0),
  pin_hash text,
  pin_fails integer NOT NULL DEFAULT 0,
  pin_lock_count integer NOT NULL DEFAULT 0,
  pin_lock_until bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_account_number_key UNIQUE (account_number)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  ua text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS transactions (
  seq bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('credit','debit')),
  category text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  balance_after bigint NOT NULL,
  narration text NOT NULL DEFAULT '',
  cp_name text NOT NULL DEFAULT '',
  cp_acct text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'Successful',
  created_at bigint NOT NULL,
  idem_key text,
  UNIQUE (user_id, idem_key)
);
CREATE INDEX IF NOT EXISTS tx_user_seq_idx ON transactions(user_id, seq DESC);
CREATE TABLE IF NOT EXISTS beneficiaries (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  PRIMARY KEY (user_id, target_id)
);
CREATE TABLE IF NOT EXISTS cards (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  tier text NOT NULL,
  name_on_card text NOT NULL,
  pan_enc text NOT NULL,
  last4 text NOT NULL,
  expiry text NOT NULL,
  status text NOT NULL,
  frozen smallint NOT NULL DEFAULT 0,
  spend_limit bigint NOT NULL DEFAULT 0,
  delivery text,
  requested_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_user_idx ON cards(user_id);
CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  window_start bigint NOT NULL
);
`;

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = tx(async q => {
      await q.query('SELECT pg_advisory_xact_lock(727274)');   // serialises cold starts
      await q.query(SQL);
    }).catch(e => { ready = null; throw e; });
  }
  return ready;
}
module.exports = { ensureSchema, SQL };
