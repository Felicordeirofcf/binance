-- TrendBot :: schema Supabase
-- Rode no SQL Editor do Supabase (projeto novo). Idempotente.
-- Chaves da Binance NAO ficam aqui: ficam em env vars da Vercel.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- 1. Configuracao (linha unica, id = 1)
-- ---------------------------------------------------------------
create table if not exists bot_config (
  id                    int primary key default 1,
  enabled               boolean not null default false,  -- master switch
  dry_run               boolean not null default true,   -- NUNCA inverta este default
  symbols               text[]  not null default '{BTCUSDT}',
  interval              text    not null default '4h',
  risk_pct              numeric not null default 0.01,   -- risco por trade (1%)
  atr_mult              numeric not null default 2.0,
  atr_period            int     not null default 14,
  donchian              int     not null default 20,
  donchian_exit         int     not null default 10,
  ema_trend             int     not null default 200,
  er_period             int     not null default 20,
  er_min                numeric not null default 0.30,   -- filtro de regime
  max_drawdown_pct      numeric not null default 20,     -- kill switch
  max_position_usdt     numeric not null default 100,    -- teto por posicao
  stop_limit_buffer_pct numeric not null default 0.005,  -- limite 0,5% abaixo do stop
  peak_equity           numeric,
  killed_at             timestamptz,
  kill_reason           text,
  paper_state           jsonb,                           -- exchange simulada do dry_run
  lock_until            timestamptz,                     -- lock contra cron concorrente
  updated_at            timestamptz not null default now(),
  constraint single_row check (id = 1),
  constraint risk_sane check (risk_pct > 0 and risk_pct <= 0.05),
  constraint dd_sane check (max_drawdown_pct > 0 and max_drawdown_pct < 100)
);

insert into bot_config (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------
-- 2. Posicoes
-- ---------------------------------------------------------------
create table if not exists positions (
  id                    uuid primary key default gen_random_uuid(),
  symbol                text not null,
  status                text not null default 'open' check (status in ('open','closed')),
  dry_run               boolean not null default true,
  qty                   numeric not null,
  entry_price           numeric not null,
  stop_price            numeric not null,
  stop_client_order_id  text,
  entry_client_order_id text,
  entry_candle_time     bigint not null,
  opened_at             timestamptz not null default now(),
  closed_at             timestamptz,
  exit_price            numeric,
  exit_reason           text,
  pnl_usdt              numeric
);

-- uma posicao aberta por simbolo, garantido pelo banco
create unique index if not exists one_open_position_per_symbol
  on positions (symbol) where status = 'open';
create index if not exists positions_symbol_idx on positions (symbol, opened_at desc);

-- ---------------------------------------------------------------
-- 3. Ordens: auditoria de toda chamada que muda dinheiro.
--    Gravada ANTES (status pending + request) e DEPOIS (resposta bruta).
-- ---------------------------------------------------------------
create table if not exists orders (
  id                uuid primary key default gen_random_uuid(),
  client_order_id   text unique not null,   -- idempotencia
  symbol            text not null,
  kind              text not null,          -- buy | sell | stop | rstop | kill | emsell
  side              text not null,
  type              text not null,
  qty               numeric,
  price             numeric,
  stop_price        numeric,
  status            text not null,          -- pending | error | not_sent | NEW | FILLED | CANCELED ...
  exchange_order_id text,
  dry_run           boolean not null default true,
  candle_time       bigint,
  raw               jsonb,
  position_id       uuid references positions(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists orders_created_idx on orders (created_at desc);
create index if not exists orders_unlinked_idx on orders (symbol, kind) where position_id is null;

-- ---------------------------------------------------------------
-- 4. Sinais: por que o bot agiu ou nao agiu. Um candle = um sinal.
-- ---------------------------------------------------------------
create table if not exists signals (
  id          uuid primary key default gen_random_uuid(),
  symbol      text not null,
  candle_time timestamptz not null,
  action      text not null,          -- buy | sell | hold
  close       numeric,
  dc_high     numeric,
  dc_low      numeric,
  ema_trend   numeric,
  atr         numeric,
  er          numeric,
  regime_ok   boolean,
  reason      text,
  dry_run     boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (symbol, candle_time)
);

create index if not exists signals_recent_idx on signals (candle_time desc);

-- ---------------------------------------------------------------
-- 5. Curva de capital
-- ---------------------------------------------------------------
create table if not exists equity_snapshots (
  id             uuid primary key default gen_random_uuid(),
  equity_usdt    numeric not null,
  free_usdt      numeric,
  position_value numeric,
  drawdown_pct   numeric,
  peak_equity    numeric,
  dry_run        boolean not null default true,
  created_at     timestamptz not null default now()
);

create index if not exists equity_created_idx on equity_snapshots (created_at desc);

-- ---------------------------------------------------------------
-- 6. Logs
-- ---------------------------------------------------------------
create table if not exists bot_logs (
  id         uuid primary key default gen_random_uuid(),
  level      text not null default 'info' check (level in ('info','warn','error')),
  message    text not null,
  context    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists logs_created_idx on bot_logs (created_at desc);

-- ---------------------------------------------------------------
-- 7. RLS ligado em TODAS as tabelas e NENHUMA policy:
--    anon/authenticated nao leem nem escrevem nada. Acesso so via
--    service_role, server-side, nas rotas da Vercel.
-- ---------------------------------------------------------------
alter table bot_config        enable row level security;
alter table positions         enable row level security;
alter table orders            enable row level security;
alter table signals           enable row level security;
alter table equity_snapshots  enable row level security;
alter table bot_logs          enable row level security;

-- defesa extra: revoga privilegios de tabela dos papeis publicos
revoke all on bot_config, positions, orders, signals, equity_snapshots, bot_logs from anon, authenticated;
