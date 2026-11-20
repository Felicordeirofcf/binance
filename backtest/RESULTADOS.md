# Resultados do backtest (gerados em 2026-11-20)

Candles de 4h. Walk-forward com 12 meses de treino e 3 meses de teste às
cegas, janela rolando de 3 em 3 meses, grade de 12 combinações
(donchian 20/40/55 × atr_mult 2/3 × er_min 0/0,30), seleção por MAR.
Só o resultado fora da amostra (OOS) conta.

## Long (Spot, taxa 0,1% + slippage 0,05%), dados spot desde 2017-08

| OOS | BTC | ETH |
|---|---|---|
| Períodos positivos | 19/31 | 19/31 |
| Retorno composto | +89,1% | +66,7% |
| Max DD encadeado | −5,95% | −7,95% |
| Profit factor | 1,79 | 1,72 |
| Maior sequência de perdas | 13 | 10 |
| Estabilidade de parâmetros | 0,19 | 0,16 |

**Passou.** Ressalva: estabilidade < 0,5, ou seja, o edge vem do tipo de
regra, não de um parâmetro ótimo.

## Short (perpétuo USDT-M 1x, taxa 0,05% + slippage 0,05% + funding real), dados desde 2020-01

| OOS | BTC short | ETH short | BTC long perp (referência) |
|---|---|---|---|
| Períodos positivos | 9/22 | 13/22 | 15/22 |
| Retorno composto | **−3,35%** | +8,41% | +46,6% |
| Profit factor (trades fechados) | **0,78** | **0,95** | 1,70 |
| Max DD encadeado | −9,13% | −5,97% | −8,74% |
| Funding líquido | +1,2% | +0,4% | −3,5% |

**Não passou.** Mesmo no bear de 2022 o short rendeu só +1% a +4% por
trimestre: em cripto as quedas são rápidas e os repiques violentos, e o
stop trailing é acionado antes da tendência render. Com os parâmetros
padrão, de 2020 a 2026, o short fez +7,25% (PF 1,02), e os 5 melhores
trades respondem por 2727% do lucro, ou seja, o resto perdeu dinheiro.

Na queda de out–nov/2026 (BTC de ~80k para ~58k), o short padrão tomou
dois stops em outubro e está posicionado desde o fim de outubro, com
+3,8% marcado a mercado. Um episódio isolado não muda o resultado
agregado.

## Como reproduzir

```bash
python fetch_data.py BTCUSDT 4h 2017-08-01
python optimize.py data/BTCUSDT_4h.csv
python fetch_futures.py BTCUSDT 4h 2019-09
python optimize.py data/BTCUSDT_4h_perp.csv --side short --fee 0.0005 --funding data/BTCUSDT_funding.csv
```
