"""Claude como analista do backtest - FORA do caminho de execucao.

A IA le as metricas e critica: aponta overfitting, concentracao de lucro,
amostra insuficiente, instabilidade de parametro. Ela NAO decide ordem,
NAO preve preco e NAO ajusta parametro. Decisao de ordem e regra
deterministica e auditavel (src/lib/strategy.ts). Nada aqui e lido pelo bot.

Uso:
    pip install anthropic
    export ANTHROPIC_API_KEY=sk-ant-...      # ou `ant auth login`
    python analyst.py results/report_BTCUSDT_4h.json results/walkforward_BTCUSDT_4h_long.json
"""
from __future__ import annotations
import json
import os
import sys

import anthropic

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5-5")

PROMPT = """Voce e um analista quantitativo cetico revisando o backtest de um
bot de tendencia long-only em cripto (candles de 4h, spot, sem alavancagem).

Sua funcao e procurar motivos para NAO colocar esse bot em producao.
Nao preveja preco. Nao sugira parametros "melhores" com base no historico -
isso seria o mesmo overfitting que voce deve detectar.

Analise obrigatoriamente:
1. A amostra e suficiente? (numero de trades, numero de ciclos de mercado)
2. O lucro esta concentrado em poucos trades? (lucro_dos_5_melhores_pct)
3. O out-of-sample degrada frente ao in-sample?
4. Os parametros escolhidos sao estaveis entre folds? (estabilidade_parametros;
   abaixo de 0,5 indica ausencia de regime estavel)
5. O drawdown e a maior sequencia de perdas sao toleraveis para um operador humano?
6. O periodo testado inclui bear market real (2018, 2022)?

Responda em portugues, em 4 secoes:
VEREDITO (producao / so paper trading / descartar)
RISCOS CONCRETOS (lista)
O QUE FALTA TESTAR (lista)
QUAL NUMERO MONITORAR EM PRODUCAO (um unico numero e seu limite de corte)

Dados:
"""


def load_payload(paths: list[str]) -> dict:
    data: dict = {}
    for p in paths:
        with open(p) as f:
            r = json.load(f)
        name = os.path.splitext(os.path.basename(p))[0]
        if "metrics" in r:  # report_*.json (engine.py)
            data[name] = {"metricas": r["metrics"], "parametros": r["params"],
                          "amostra_de_trades": r["trades"][:40]}
        elif "resumo_out_of_sample" in r:  # walkforward_*.json (optimize.py)
            data[name] = {
                "resumo_out_of_sample": r["resumo_out_of_sample"],
                "grade": r.get("grade"),
                "folds": [{k: f[k] for k in ("teste", "params_escolhidos", "in_sample_score")}
                          | {"oos": {k: f["out_of_sample"].get(k) for k in
                                     ("retorno_total_pct", "max_drawdown_pct", "trades", "buy_and_hold_pct")}}
                          for f in r["folds"]],
            }
    return data


def critique(payload: dict) -> str:
    client = anthropic.Anthropic()
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=16000,
        output_config={"effort": "high"},
        # se o modelo recusar, a API refaz a chamada num modelo de fallback
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{"role": "user", "content": PROMPT + json.dumps(payload, indent=2, ensure_ascii=False)}],
    )
    if response.stop_reason == "refusal":
        cat = response.stop_details.category if response.stop_details else None
        raise SystemExit(f"Modelo recusou a analise (categoria: {cat}).")
    return "".join(b.text for b in response.content if b.type == "text")


def main() -> None:
    paths = sys.argv[1:] or ["results/report_BTCUSDT_4h.json", "results/walkforward_BTCUSDT_4h_long.json"]
    payload = load_payload(paths)
    if not payload:
        raise SystemExit("nenhum arquivo de resultado valido")
    try:
        out = critique(payload)
    except anthropic.AuthenticationError:
        raise SystemExit("Sem credencial: defina ANTHROPIC_API_KEY ou rode `ant auth login`.")
    except anthropic.RateLimitError:
        raise SystemExit("Rate limit da API: tente de novo em alguns minutos.")
    except anthropic.APIStatusError as e:
        raise SystemExit(f"Erro da API ({e.status_code}): {e.message}")
    except anthropic.APIConnectionError:
        raise SystemExit("Falha de conexao com a API da Anthropic.")
    print(out)
    os.makedirs("results", exist_ok=True)
    with open("results/analise.md", "w") as f:
        f.write(out)
    print("\n-> results/analise.md")


if __name__ == "__main__":
    main()
