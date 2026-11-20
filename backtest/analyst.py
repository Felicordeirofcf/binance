"""Claude como analista do backtest - FORA do caminho de execucao.

A IA le as metricas e critica: aponta overfitting, concentracao de
lucro, amostra insuficiente, instabilidade de parametro. Ela NAO decide
ordem e NAO preve preco. Decisao de ordem fica em regra deterministica.

Uso:
    export ANTHROPIC_API_KEY=sk-...
    python analyst.py report.json walkforward.json
"""
from __future__ import annotations
import json
import os
import sys
import urllib.request

PROMPT = """Voce e um analista quantitativo cetico revisando o backtest de um
bot de tendencia long-only em BTC/USDT (candles de 4h, spot, sem alavancagem).

Sua funcao e procurar motivos para NAO colocar esse bot em producao.
Nao preveja preco. Nao sugira parametros "melhores" com base no historico -
isso seria o mesmo overfitting que voce deve detectar.

Analise obrigatoriamente:
1. Amostra e suficiente? (numero de trades, numero de ciclos de mercado)
2. O lucro esta concentrado em poucos trades? (lucro_dos_5_melhores_pct)
3. Out-of-sample degrada frente ao in-sample?
4. Os parametros escolhidos sao estaveis entre folds? (estabilidade_parametros;
   abaixo de 0.5 indica ausencia de regime estavel)
5. O drawdown e a maior sequencia de perdas sao toleraveis para um operador humano?
6. O periodo testado inclui bear market real?

Responda em portugues, em 4 secoes:
VEREDITO (producao / so paper trading / descartar)
RISCOS CONCRETOS (lista)
O QUE FALTA TESTAR (lista)
QUAL NUMERO MONITORAR EM PRODUCAO (um unico numero e seu limite de corte)

Dados:
"""


def ask_claude(payload: str) -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return "ANTHROPIC_API_KEY nao definida."
    body = json.dumps({
        "model": "claude-opus-5",
        "max_tokens": 2000,
        "messages": [{"role": "user", "content": PROMPT + payload}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())["content"][0]["text"]


def main() -> None:
    report = sys.argv[1] if len(sys.argv) > 1 else "report.json"
    wf = sys.argv[2] if len(sys.argv) > 2 else "walkforward.json"

    data = {}
    with open(report) as f:
        r = json.load(f)
        data["backtest_completo"] = r["metrics"]
        data["parametros"] = r["params"]
        data["amostra_de_trades"] = r["trades"][:40]
    try:
        with open(wf) as f:
            data["walk_forward"] = json.load(f)["resumo_out_of_sample"]
    except FileNotFoundError:
        data["walk_forward"] = "nao executado - rode optimize.py"

    out = ask_claude(json.dumps(data, indent=2, ensure_ascii=False))
    print(out)
    with open("analise.md", "w") as f:
        f.write(out)
    print("\n-> analise.md")


if __name__ == "__main__":
    main()
