/** Alpaca Sandbox only. All decimal values are strings; no local wallet balances. */
export type AlpacaSymbol = "BTC/USD" | "ETH/USD";
export interface AlpacaDemoStatus {
  configured: boolean;
  environment: "sandbox";
  account: { status: string; cryptoStatus: string } | null;
  provisioningStatus: string;
  fundingStatus: string;
}
export interface AlpacaDemoOrder {
  id: string; clientOrderId: string; symbol: string; side: string; type: string;
  qty: string; filledQty: string; filledAvgPrice: string | null;
  limitPrice: string | null; status: string; createdAt: string;
  /** Provider-reported commission; null means not reported, never assumed zero. */
  commission: string | null;
  commissionType: string | null;
}
export interface AlpacaDemoPortfolio {
  source: "Alpaca Broker Sandbox"; currency: "USD";
  cash: string; buyingPower: string; portfolioValue: string;
  accountStatus: string; cryptoStatus: string;
  positions: { symbol: string; qty: string; marketValue: string; avgEntryPrice: string }[];
}
export interface AlpacaDemoMarket {
  source: string; referenceOnly: boolean; symbol: AlpacaSymbol;
  quote: { bid: string; ask: string; timestamp: string };
  bars: { time: number; open: number; high: number; low: number; close: number; volume: number }[];
}
// GET status => AlpacaDemoStatus; POST enable {consent:true} => AlpacaDemoStatus.
// GET portfolio => AlpacaDemoPortfolio; GET orders?status=all|open => {orders:AlpacaDemoOrder[]}.
// POST orders {symbol,side:"buy"|"sell",type:"market"|"limit",qty,limitPrice?,idempotencyKey:UUID}
// => AlpacaDemoOrder; DELETE orders/:id => {status:"cancel_requested"}.
// GET market?symbol=BTC/USD => AlpacaDemoMarket. Errors => {code,message}.