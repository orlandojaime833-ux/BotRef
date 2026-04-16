-- ═══════════════════════════════════════════════════════════════
--  TaskMarket — Schema Supabase COMPLETO
--  Executa no Supabase SQL Editor (Project Settings → SQL Editor)
-- ═══════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
--  1. USERS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  telegram_id     TEXT UNIQUE NOT NULL,
  username        TEXT,
  balance         NUMERIC(12,4) NOT NULL DEFAULT 0,   -- saldo em EUR
  ton_balance     NUMERIC(12,6) NOT NULL DEFAULT 0,   -- saldo TON de referências
  referral_count  INTEGER       NOT NULL DEFAULT 0,   -- nº total de referências feitas
  referred_by     BIGINT REFERENCES users(id),        -- quem o referenciou
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
--  2. TASKS
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id             BIGSERIAL PRIMARY KEY,
  advertiser_id  BIGINT REFERENCES users(id) NOT NULL,
  executor_id    BIGINT REFERENCES users(id),
  title          TEXT          NOT NULL,
  description    TEXT,
  reward         NUMERIC(12,4) NOT NULL,
  deadline       TEXT,
  status         TEXT          NOT NULL DEFAULT 'open',
    -- 'open' | 'in_progress' | 'pending_review' | 'completed' | 'cancelled'
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
--  3. TRANSACTIONS  (registo de todos os movimentos financeiros)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) NOT NULL,
  type        TEXT          NOT NULL,
    -- 'deposit' | 'withdrawal' | 'payment' | 'receipt' | 'ton_withdrawal'
  amount      NUMERIC(12,4) NOT NULL,
  task_id     BIGINT REFERENCES tasks(id),
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
--  4. REFERRALS  (histórico de referências)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id                 BIGSERIAL PRIMARY KEY,
  referrer_id        BIGINT REFERENCES users(id) NOT NULL,
  referred_telegram  TEXT  NOT NULL,   -- telegram_id do novo utilizador
  ton_credited       NUMERIC(12,6) NOT NULL DEFAULT 0.01,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────
--  5. DEPOSIT_INVOICES  (invoices CryptoBot para anunciantes)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deposit_invoices (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) NOT NULL,
  invoice_id  TEXT UNIQUE NOT NULL,    -- ID da invoice no CryptoBot
  amount_ton  NUMERIC(12,6) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'paid' | 'expired'
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  paid_at     TIMESTAMPTZ
);

-- ────────────────────────────────────────────────────────────────
--  6. FUNÇÃO RPC: pay_executor
--     Chamada quando anunciante aprova a tarefa.
--     Credita a recompensa ao executor e regista ambas as transações.
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pay_executor(task_id BIGINT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_task    tasks%ROWTYPE;
  v_reward  NUMERIC;
BEGIN
  SELECT * INTO v_task FROM tasks WHERE id = task_id;
  IF v_task.id IS NULL THEN
    RAISE EXCEPTION 'Task % not found', task_id;
  END IF;

  v_reward := v_task.reward;

  -- Credita saldo ao executor
  UPDATE users
    SET balance = balance + v_reward
    WHERE id = v_task.executor_id;

  -- Regista recebimento (executor)
  INSERT INTO transactions (user_id, type, amount, task_id, note)
    VALUES (v_task.executor_id, 'receipt', v_reward, task_id, 'Pagamento por tarefa concluída');

  -- Regista pagamento (anunciante — valor já foi debitado no escrow ao publicar)
  INSERT INTO transactions (user_id, type, amount, task_id, note)
    VALUES (v_task.advertiser_id, 'payment', v_reward, task_id, 'Pagamento de tarefa a executor');
END;
$$;

-- ────────────────────────────────────────────────────────────────
--  7. TRIGGER: atualiza updated_at em tasks
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ────────────────────────────────────────────────────────────────
--  8. ÍNDICES para performance
-- ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_users_telegram      ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status        ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_advertiser    ON tasks(advertiser_id);
CREATE INDEX IF NOT EXISTS idx_tasks_executor      ON tasks(executor_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer  ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_invoices_invoice_id ON deposit_invoices(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoices_user       ON deposit_invoices(user_id, status);
CREATE INDEX IF NOT EXISTS idx_txn_user            ON transactions(user_id);

-- ────────────────────────────────────────────────────────────────
--  9. RLS (Row Level Security) — desliga para service_role
--     O bot usa service_role key, que bypassa RLS.
--     Se quiseres expor dados via anon key, activa RLS abaixo.
-- ────────────────────────────────────────────────────────────────
-- ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tasks              ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE transactions       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE referrals          ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE deposit_invoices   ENABLE ROW LEVEL SECURITY;
