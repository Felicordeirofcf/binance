# TrendBot

Bot de tendência para **Binance Spot** (só comprado) ou **Futuros USDT-M**
(comprado e vendido, margem isolada, alavancagem até 10x), em candles de 4h, com
painel web. Next.js 15 na Vercel, estado e auditoria no Supabase, backtest em Python.

O default é o que foi validado no backtest: **Spot, comprado, 1x, risco de 1% por
trade**. Futuros, alavancagem e bot vendido só ligam por escolha explícita no painel.

> Este software envia ordens com dinheiro real quando `dry_run = false`.
> Backtest não é promessa de resultado. Siga o roteiro da seção 6 sem pular etapas.

---

## 1. Estratégia

| | Regra |
|---|---|
| **Entrada** (sem posição) | `close > máxima dos 20 candles anteriores` **e** `close > EMA(200)` **e** `Efficiency Ratio(20) ≥ 0,30` |
| **Stop** | `entrada − 2 × ATR(14)` (ATR de Wilder), trailing: só sobe |
| **Saída** | `close < mínima dos 10 candles anteriores`, ou stop atingido |
| **Sizing** | `qty = (equity × 1%) / (preço − stop)`, limitado ao saldo livre e a `max_position_usdt` |

A estratégia existe duas vezes, em `backtest/engine.py` e em `src/lib/strategy.ts`.
O teste `tests/parity.test.ts` compara as duas candle a candle num CSV real de 1.500 candles.
O teste `tests/engine.test.ts` roda a engine de produção em dry-run sobre o mesmo
histórico e confere que ela entra e sai **nos mesmos candles** do backtest.

### Resultado do backtest

Detalhes em [`backtest/RESULTADOS.md`](backtest/RESULTADOS.md). Resumo do walk-forward
fora da amostra (12 meses de treino, 3 meses às cegas, 31 períodos de 2018 a 2026):

| | BTC | ETH |
|---|---|---|
| Retorno composto OOS | +89% | +67% |
| Max drawdown encadeado | −6,0% | −8,0% |
| Profit factor | 1,79 | 1,72 |
| Períodos positivos | 19/31 | 19/31 |
| Estabilidade de parâmetros | 0,19 | 0,16 |

A estabilidade abaixo de 0,5 indica que não há um parâmetro ótimo: o edge vem do tipo
de regra. Em mercado de alta a estratégia rende muito menos que o buy & hold, com uma
fração do drawdown. A versão vendida em futuros foi testada e **descartada**
(profit factor 0,78 no BTC).

---

## 2. Como funciona uma execução

O Vercel Cron chama `GET /api/cron/run` toda hora, no minuto 2 (`vercel.json`).
Os candles são de 4h, então só a primeira execução depois de cada fechamento age.
As outras três reconciliam e não fazem nada, por idempotência.

```
lock global ──► dados (só candles fechados) ──► RECONCILIA com a Binance
   ──► equity + kill switch ──► AVALIA (strategy.ts) ──► EXECUTA ──► REGISTRA
```

`src/lib/engine.ts` faz tudo isso, sempre pela interface `Broker`:

- `LiveBroker` fala com a Binance (produção ou testnet).
- `PaperBroker` simula a exchange no dry-run. O **mesmo código** roda nos dois modos:
  o dry-run testa o caminho real, não uma cópia.

## 3. Invariantes de segurança e onde estão

| # | Invariante | Implementação |
|---|---|---|
| 1 | `dry_run = true` é o default | `schema.sql` (default), `engine.ts` (só é real se o banco disser **exatamente** `false`). O painel **não consegue** ligar o modo real, só voltar para o dry-run. |
| 2 | Stop no servidor da Binance | Spot: `STOP_LOSS_LIMIT` GTC. Futuros: `STOP_MARKET` com `closePosition=true` via `POST /fapi/v1/algoOrder` (o endpoint comum não aceita mais stops), gatilho no preço de marcação. Colocado logo após a entrada. Se o stop é rejeitado, a posição é vendida na hora. Toda execução confere se o stop existe e recoloca se sumiu. |
| 3 | `clientOrderId` determinístico | `risk.ts::clientOrderId` → `tb_{tipo}_{symbol}_{candleOpenTime}`, mais `UNIQUE` em `orders.client_order_id`. Nunca trunca: falha se passar de 36 caracteres. |
| 4 | Reconciliação antes de decidir | `engine.ts::reconcile`: stop executado fecha a posição local; compra feita sem gravação (crash) vira posição com stop; saldo vendido fora do bot encerra a posição; preço abaixo do stop sem execução (gap) dispara saída de emergência. |
| 5 | Descartar o candle aberto | `binance.ts::getClosedCandles` / `dropOpenCandle` |
| 6 | Kill switch a −20% do pico | `risk.ts::checkKillSwitch` + `engine.ts`: fecha tudo, grava `killed_at`/`kill_reason`, desliga. Só volta com "Rearmar" + "Ligar" manuais. |
| 7 | Filtros da exchange | `binance.ts::getFilters` (`LOT_SIZE`, `PRICE_FILTER`, `NOTIONAL`) e `roundStep` (aritmética inteira, sem erro de float) |
| 8 | Chaves só na Vercel | `.env.example`. O schema não tem coluna de chave. |
| 9 | RLS sem policy pública | `schema.sql`: RLS ligado e `revoke` para `anon`/`authenticated`. O painel lê via `/api/state` com `service_role` no servidor. |
| 10 | Auditoria de toda ordem | `engine.ts::submit`: grava `pending` + request **antes**, response ou erro **depois** (`orders.raw`). |

Proteções adicionais:

- Lock no banco contra cron duplicado.
- Sinal "expira" se o cron atrasar mais que um candle (não compra horas depois a outro preço).
- Funções fixadas em São Paulo (`gru1`): a Binance bloqueia IPs dos EUA, que é a região padrão da Vercel.
- Painel e controles atrás de HTTP Basic Auth, com checagem de origem (CSRF).

---

### Futuros USDT-M (opcional)

Ligue em **Mercado e alavancagem** no painel. Exige não ter posição aberta.

- **Margem isolada e modo One-way:** o bot configura a margem isolada sozinho. Ele
  **recusa** contas em modo Hedge; mude para "posição única" nas configurações de
  Futuros da Binance.
- **Alavancagem de 1x a 10x**, no bot e no manual. A entrada é recusada se o stop
  ficar a mais de 80% da distância até a liquidação.
- **Chave:** precisa de "Enable Futures", além de leitura e trading, e nunca de saque.
  `BINANCE_FUTURES_API_KEY` e `BINANCE_FUTURES_API_SECRET` são opcionais; sem elas,
  usa as chaves de Spot.
- **Testnet:** `BINANCE_FUTURES_BASE_URL=https://testnet.binancefuture.com`, com
  chaves do testnet de futuros.
- **Funding** a cada 8h não é simulado no papel. No real ele custa ou paga cerca de
  0,01% por período.

Com o sizing por risco, **a alavancagem sozinha não muda ganho nem perda**: a perda
no stop continua sendo 1% do capital, e a alavancagem só reduz a margem presa. O que
aumenta ganho e perda é o risco por trade. Backtest BTC 2017–2026, dentro da amostra,
sem liquidação nem funding:

| Risco/trade | 1x | 3x | 5x |
|---|---|---|---|
| 1% | 11,3% a.a., DD −11,8% | igual | igual |
| 2% | 16,4% a.a., DD −23,6% | 22,1% a.a., DD −22,8% | igual ao 3x |
| 5% | 16,8% a.a., DD −34,6% | 42,4% a.a., DD −50,0% | 51,0% a.a., DD −50,3% |

A partir de 2% de risco, o drawdown passa do kill switch de 20%. **O bot vendido**
(`short_enabled`) reprovou no walk-forward, com profit factor 0,78 no BTC: ligue
sabendo que essa regra perdeu dinheiro fora da amostra.

## 4. Deploy: Supabase → GitHub → Vercel

### 4.1 Supabase
1. Crie um projeto em <https://supabase.com>.
2. **SQL Editor** → cole e rode `supabase/schema.sql`. O script pode ser rodado de novo sem problema.
3. **Project Settings → API**: copie a `Project URL` (`SUPABASE_URL`) e a chave `service_role` (`SUPABASE_SERVICE_ROLE_KEY`).
   **Não** use a `anon key` em lugar nenhum.

### 4.2 GitHub
Faça o push deste repositório para o seu GitHub. O `.gitignore` já exclui `.env*`
(exceto `.env.example`), `backtest/data/` e `backtest/results/`.

### 4.3 Vercel (plano Pro, necessário para o cron horário)
1. **Add New → Project** → importe o repositório (framework: Next.js).
2. **Settings → Environment Variables**: cadastre as variáveis do `.env.example`.
   Para começar, **não** cadastre as chaves da Binance: o dry-run não precisa delas.
   - `CRON_SECRET`: `openssl rand -hex 32`
   - `DASHBOARD_PASSWORD`: no mínimo 12 caracteres
3. Faça o deploy. O cron de `vercel.json` aparece em **Settings → Cron Jobs**.
4. Abra o painel, faça login, clique em **Executar agora** e depois **ligue** o bot.
   Ele opera em papel com `PAPER_INITIAL_USDT`.

## 5. Chave da Binance: sem saque, com IP allowlist

1. Binance → **Perfil → Gerenciamento de API → Criar API** → "Gerada pelo sistema".
   Use preferencialmente uma **subconta dedicada** ao bot. Assim o saldo e o drawdown
   do bot não se misturam com o resto da sua carteira, e o bot não vende moedas suas.
2. Em **Editar restrições**:
   - ✅ **Enable Reading**
   - ✅ **Enable Spot & Margin Trading**
   - ❌ **Enable Withdrawals**: **nunca**
   - ❌ Margin, Futures, Universal Transfer: desligados
3. **Restrict access to trusted IPs only**: as funções serverless da Vercel não têm IP
   fixo por padrão. Para a allowlist funcionar:
   - ative IPs estáticos de saída no seu plano da Vercel (procure por *Static IPs* nas
     configurações do projeto ou do time; é recurso pago);
   - cadastre esses IPs na Binance.
   Sem IP fixo não há allowlist. Nesse caso a segurança depende só de a chave não ter
   saque, e o risco é maior.
4. Cadastre `BINANCE_API_KEY` e `BINANCE_API_SECRET` **só na Vercel** e faça o redeploy.

### Ligar o modo real (só pelo banco, de propósito)
Com o bot desligado e sem posições abertas no dry-run, rode no SQL Editor do Supabase:

```sql
update bot_config
set dry_run = false, enabled = false, peak_equity = null, paper_state = null
where id = 1;
```

Depois ligue pelo painel. Para voltar ao papel, use o botão "Voltar p/ dry-run".

---

## 6. Roteiro obrigatório: backtest → testnet → 5% → escala

| Etapa | O que fazer | Critério para avançar |
|---|---|---|
| **1. Backtest** | `backtest/`: rode o walk-forward nos ativos que vai operar e leia `RESULTADOS.md` | Out-of-sample positivo, drawdown tolerável, você entende a maior sequência de perdas (10 a 13 trades seguidos) |
| **2. Dry-run** | Deploy com `dry_run = true` por **pelo menos 4 semanas** | Os sinais do painel batem com o que o backtest faria; nenhum erro nos logs |
| **3. Testnet** | Chaves de <https://testnet.binance.vision>, `BINANCE_BASE_URL=https://testnet.binance.vision`, `dry_run = false` | Compra, stop no servidor, trailing, saída, kill switch manual e reconciliação (cancele o stop na mão e veja o bot recolocar) funcionando, com as ordens em `orders` |
| **4. 5% do capital** | Produção numa subconta com **5% do capital** que você pretende usar; `max_position_usdt` baixo | 3 meses ou 15 trades. Resultado coerente com o backtest; drawdown dentro do esperado |
| **5. Escala** | Aumente o capital em degraus (por exemplo, ×2 por mês) | Nunca escale após uma sequência de ganhos, nem para "recuperar" perdas |

Em qualquer etapa: se a divergência para o backtest não tiver explicação, volte uma etapa.

---

## 7. Desenvolvimento

```bash
npm install
cp .env.example .env.local   # preencha
npm run dev                  # http://localhost:3000
npm test                     # 41 testes (inclui a paridade Python, que exige python3 + pandas)
npm run build
```

Para disparar o cron localmente:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/run
```

### Backtest

```bash
cd backtest
pip install -r requirements.txt
python fetch_data.py BTCUSDT 4h 2017-08-01        # dados públicos, sem chave
python engine.py data/BTCUSDT_4h.csv              # backtest completo
python optimize.py data/BTCUSDT_4h.csv            # walk-forward (o que conta)
python analyst.py results/report_BTCUSDT_4h.json results/walkforward_BTCUSDT_4h_long.json
```

`analyst.py` envia as métricas para a API da Anthropic e pede uma crítica cética.
**A IA fica fora do caminho de execução:** não decide ordem, não prevê preço e não
ajusta parâmetro. Nenhum código do bot lê a saída dela.

## 8. Limitações conhecidas

- **Gap abaixo do limite do stop:** o `STOP_LOSS_LIMIT` usa limite 0,5% abaixo do stop
  (`stop_limit_buffer_pct`). Num gap maior ele pode não executar. A próxima execução do
  cron detecta e vende a mercado, mas pode levar até uma hora.
- **Trailing stop:** subir o stop exige cancelar o antigo e criar o novo. Entre as duas
  chamadas há uma janela de milissegundos sem stop. Se a criação falhar, o stop antigo
  é recolocado; se isso também falhar, a posição é vendida.
- **EMA de produção:** é calculada sobre os últimos 1.000 candles, enquanto o backtest
  usa o histórico inteiro. A diferença residual é de ~0,003% do valor. A paridade é
  testada no mesmo CSV.
- **Execução:** o backtest executa no open do candle seguinte; o bot executa ~2 minutos
  depois. O dry-run preenche pelo último close com 0,05% de slippage.
- **Escopo:** só pares `*USDT`, uma posição por símbolo.
- **Futuros:** o preço de liquidação no papel é uma estimativa (manutenção de 0,5%).
  No real, o bot usa o valor que a Binance informa em `positionRisk`.
