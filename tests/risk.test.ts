import { describe, expect, it } from "vitest";
import { checkKillSwitch, clientOrderId, sizePosition } from "@/lib/risk";
import { dropOpenCandle, fmt, parseFilters, roundStep, sign } from "@/lib/binance";
import { c } from "./helpers";

const filters = { stepSize: 0.00001, tickSize: 0.01, minQty: 0.00001, minNotional: 5 };
const cfg = { atr_mult: 2, risk_pct: 0.01, max_position_usdt: 1_000_000 };

describe("sizePosition", () => {
  it("qty = (equity x 1%) / (preco - stop)", () => {
    // equity 10000, risco 100; stop = 50000 - 2*500 = 49000; qty = 100/1000 = 0.1
    const r = sizePosition(10_000, 10_000, 50_000, 500, cfg, filters);
    expect(r.ok && r.qty).toBe(0.1);
    expect(r.ok && r.stop).toBe(49_000);
    expect(r.ok && r.riskUsdt).toBeCloseTo(100, 6);
  });

  it("nao depende de percentual do saldo: ATR maior => posicao menor", () => {
    const a = sizePosition(10_000, 10_000, 50_000, 500, cfg, filters);
    const b = sizePosition(10_000, 10_000, 50_000, 1000, cfg, filters);
    expect(a.ok && b.ok && b.qty).toBe(a.ok ? a.qty / 2 : NaN);
  });

  it("spot nao alavanca: limita ao saldo livre", () => {
    // risco pediria 0.1 BTC (5000 USDT) mas so ha 1000 livres
    const r = sizePosition(10_000, 1000, 50_000, 500, cfg, filters);
    expect(r.ok && r.notional).toBeLessThanOrEqual(1000);
  });

  it("respeita max_position_usdt", () => {
    const r = sizePosition(10_000, 10_000, 50_000, 500, { ...cfg, max_position_usdt: 100 }, filters);
    expect(r.ok && r.notional).toBeLessThanOrEqual(100);
  });

  it("arredonda para baixo no stepSize", () => {
    const r = sizePosition(1234, 1234, 43_210.5, 321.7, cfg, filters);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.round(r.qty / filters.stepSize) * filters.stepSize).toBeCloseTo(r.qty, 12);
  });

  it("recusa abaixo do minNotional", () => {
    // risco 1 USDT / 1000 por unidade = 0.001 BTC = 50 USDT < 100
    const r = sizePosition(100, 100, 50_000, 500, cfg, { ...filters, minNotional: 100 });
    expect(r.ok).toBe(false);
  });

  it("recusa ATR invalido", () => {
    expect(sizePosition(1000, 1000, 100, 0, cfg, filters).ok).toBe(false);
    expect(sizePosition(1000, 1000, 100, 80, cfg, filters).ok).toBe(false); // stop negativo
  });
});

describe("kill switch", () => {
  it("dispara com drawdown >= 20% do pico", () => {
    expect(checkKillSwitch(800, 1000, 20).killed).toBe(true);
    expect(checkKillSwitch(799, 1000, 20).killed).toBe(true);
    expect(checkKillSwitch(801, 1000, 20).killed).toBe(false);
  });
  it("pico acompanha a equity", () => {
    const k = checkKillSwitch(1200, 1000, 20);
    expect(k.killed).toBe(false);
    expect(k.peak).toBe(1200);
  });
  it("sem pico registrado usa a equity atual", () => {
    expect(checkKillSwitch(500, null, 20).killed).toBe(false);
  });
  it("aceita limite negativo ou positivo", () => {
    expect(checkKillSwitch(790, 1000, -20).killed).toBe(true);
  });
});

describe("clientOrderId", () => {
  it("formato tb_{tipo}_{symbol}_{candleOpenTime}", () => {
    expect(clientOrderId("buy", "BTCUSDT", 1_700_006_400_000)).toBe("tb_buy_BTCUSDT_1700006400000");
  });
  it("deterministico: mesmo candle => mesmo id (restart/cron duplicado colidem)", () => {
    const a = clientOrderId("stop", "ETHUSDT", 1_700_006_400_000);
    const b = clientOrderId("stop", "ETHUSDT", 1_700_006_400_000);
    expect(a).toBe(b);
  });
  it("candles, tipos e symbols diferentes => ids diferentes", () => {
    const ids = new Set([
      clientOrderId("buy", "BTCUSDT", 1_700_006_400_000),
      clientOrderId("buy", "BTCUSDT", 1_700_020_800_000),
      clientOrderId("sell", "BTCUSDT", 1_700_006_400_000),
      clientOrderId("buy", "ETHUSDT", 1_700_006_400_000),
    ]);
    expect(ids.size).toBe(4);
  });
  it("respeita o limite de 36 caracteres da Binance sem truncar", () => {
    expect(clientOrderId("rstop", "1000SATSUSDT", 1_700_006_400_000).length).toBeLessThanOrEqual(36);
    expect(() => clientOrderId("rstop", "SUPERLONGSYMBOLUSDT", 1_700_006_400_000)).toThrow(/36/);
    expect(clientOrderId("buy", "BTCUSDT", 1_700_006_400_000)).toMatch(/^[.A-Z:/a-z0-9_-]{1,36}$/);
  });
  it("rejeita entradas invalidas", () => {
    expect(() => clientOrderId("buy", "btc-usdt", 1)).toThrow();
    expect(() => clientOrderId("buy", "BTCUSDT", 1.5)).toThrow();
    // @ts-expect-error tipo invalido
    expect(() => clientOrderId("market", "BTCUSDT", 1)).toThrow();
  });
});

describe("filtros da exchange", () => {
  it("roundStep arredonda para baixo sem erro de ponto flutuante", () => {
    expect(roundStep(0.12345678, 0.00001)).toBe(0.12345);
    expect(roundStep(0.3, 0.1)).toBe(0.3); // 0.1+0.2 != 0.3 em float
    expect(roundStep(1.0000000001, 0.001)).toBe(1);
    expect(roundStep(43210.567, 0.01)).toBe(43210.56);
    expect(roundStep(12.9, 1)).toBe(12);
    expect(roundStep(0.000123, 1e-8)).toBe(0.000123);
  });
  it("fmt nao usa notacao cientifica", () => {
    expect(fmt(0.00000123, 0.00000001)).toBe("0.00000123");
    expect(fmt(43210.5, 0.01)).toBe("43210.50");
  });
  it("parseFilters le LOT_SIZE, PRICE_FILTER e NOTIONAL", () => {
    const f = parseFilters([
      { filterType: "PRICE_FILTER", tickSize: "0.01000000" },
      { filterType: "LOT_SIZE", stepSize: "0.00001000", minQty: "0.00001000" },
      { filterType: "NOTIONAL", minNotional: "5.00000000" },
    ]);
    expect(f).toEqual({ stepSize: 0.00001, tickSize: 0.01, minQty: 0.00001, minNotional: 5 });
    expect(() => parseFilters([])).toThrow();
  });
});

describe("cliente Binance", () => {
  it("assinatura HMAC SHA256 = exemplo da documentacao oficial", () => {
    const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const q = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(sign(q, secret)).toBe("c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });
  it("descarta o ultimo candle (aberto) e qualquer candle com fechamento futuro", () => {
    const cs = [c(0, 1, 1, 1, 1), c(1, 1, 1, 1, 1), c(2, 1, 1, 1, 1)];
    const now = cs[2].closeTime - 1000; // candle 2 em andamento
    expect(dropOpenCandle(cs, now).map((x) => x.openTime)).toEqual([cs[0].openTime, cs[1].openTime]);
    expect(dropOpenCandle(cs, cs[1].closeTime - 1).length).toBe(1);
  });
});
