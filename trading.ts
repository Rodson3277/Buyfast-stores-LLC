export type TradingSymbol = "BTCUSDT" | "ETHUSDT";
export type TradingAsset = "USDT" | "BTC" | "ETH";
export type TradingOrder = {
  id: string; symbol: TradingSymbol; side: "buy" | "sell"; type: "market" | "limit";
  quantity: string; limitPrice: string | null; status: "open" | "filled" | "cancelled";
  reserved: string; createdAt: string; fillPrice?: string; fee?: string;
};
export type TradingState = {
  initialized: boolean; main: string;
  balances: Record<TradingAsset, { available: string; reserved: string }>;
  orders: TradingOrder[];
};
export type TradingMarket = {
  symbol: TradingSymbol; price: string; source: string; updatedAt: string;
  candles: { time: number; open: number; high: number; low: number; close: number }[];
};
export type TradingAction =
  | { action: "faucet" }
  | { action: "transfer"; direction: "toTrading" | "toMain"; amount: string }
  | { action: "order"; symbol: TradingSymbol; side: "buy" | "sell"; type: "market" | "limit"; quantity: string; limitPrice?: string }
  | { action: "cancel"; orderId: string }
  | { action: "sync" };
export const TRADING_FEE_BPS = 10;
export const TRADING_QUOTE_MAX_AGE = 30_000;