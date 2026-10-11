// The MyFiat Assistant's tools. Each maps to the MyFiat API and runs AS the
// signed-in user (the caller's Bearer token is threaded through). Tool results
// are short human-readable summaries the model turns into a reply. Everything
// degrades gracefully: if the API is down or a field is missing, the tool says
// so instead of throwing.

import { apiGet, apiPost, asList, money, usd, label, ApiDownError } from "./myfiat.js";

// Which tools change state — the server reports these back as action chips, and
// the persona must confirm before calling them.
export const ACTION_TOOLS = new Set([
  "renew_card",
  "freeze_card",
  "unfreeze_card",
  "cancel_subscription",
  "dispute_charge",
  "resolve_alert",
  "send_money",
  "buy_crypto",
]);

export const tools = [
  {
    type: "function",
    function: {
      name: "get_overview",
      description:
        "Get the customer's profile and account balances — the quick 'how am I doing' overview. Use for balances, 'what's in my account', total cash.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_net_worth",
      description:
        "Summarize net worth across cash accounts plus investment holdings (stocks and crypto). Use for 'what am I worth', 'net worth', total across everything.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_transactions",
      description:
        "List the customer's recent transactions (most recent first). Use for 'where did my money go', 'recent activity', 'what did I spend lately'.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", description: "How many to return (default 10)." },
          query: { type: "string", description: "Optional text to match in the merchant/description, e.g. 'coffee', 'amazon'." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_spending_breakdown",
      description:
        "Break the customer's recent spending down by category, or answer 'how much did I spend on X' (e.g. coffee, groceries, dining). Uses MyFiat insights when available, otherwise sums recent transactions.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", description: "Optional single category or keyword to total, e.g. 'coffee', 'dining', 'subscriptions'." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_insights",
      description:
        "Get MyFiat's own generated money insights for this customer (trends, unusual spend, savings tips). Use for 'any insights', 'how am I trending', proactive tips.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_subscriptions",
      description:
        "List the customer's recurring subscriptions, flagging ones that look wasteful (rarely used, duplicated, or recently increased in price). Use for 'my subscriptions', 'am I wasting money', 'what am I paying for monthly'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_upcoming_bills",
      description:
        "List subscriptions/bills due soon with their next charge dates and the monthly total. Use for 'upcoming bills', 'what's due', 'what's coming out this week'.",
      parameters: {
        type: "object",
        properties: { days: { type: "integer", description: "Look-ahead window in days (default 14)." } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_portfolio",
      description:
        "Summarize the customer's investments — stocks and crypto holdings, total value, and biggest gainers/losers. Use for 'how are my stocks', 'my crypto', 'portfolio', 'investments'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_cards",
      description:
        "List the customer's cards with their status, last 4 digits, and expiry, flagging any expiring soon or frozen. Use before renewing/freezing when you need the card id, or for 'my cards'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_alerts",
      description:
        "List the customer's open alerts (including suspicious_charge fraud alerts). Use for 'any alerts', 'is anything wrong', and to find the alert/transaction behind a suspicious charge.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "renew_card",
      description:
        "Renew a card that's expiring (issues a replacement). CONFIRM with the customer first. Needs the card id — call list_cards if you don't have it.",
      parameters: {
        type: "object",
        properties: { card_id: { type: "string", description: "The id of the card to renew." } },
        required: ["card_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "freeze_card",
      description:
        "Freeze (lock) a card so no new charges go through — e.g. lost card or suspected fraud. CONFIRM with the customer first. Needs the card id.",
      parameters: {
        type: "object",
        properties: { card_id: { type: "string", description: "The id of the card to freeze." } },
        required: ["card_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unfreeze_card",
      description: "Unfreeze (unlock) a previously frozen card so it can be used again. CONFIRM with the customer first. Needs the card id.",
      parameters: {
        type: "object",
        properties: { card_id: { type: "string", description: "The id of the card to unfreeze." } },
        required: ["card_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_subscription",
      description:
        "Cancel a recurring subscription so the customer stops being billed. CONFIRM with the customer first. Needs the subscription id — call list_subscriptions if you don't have it.",
      parameters: {
        type: "object",
        properties: { subscription_id: { type: "string", description: "The id of the subscription to cancel." } },
        required: ["subscription_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dispute_charge",
      description:
        "Open a dispute on a transaction the customer doesn't recognize or believes is wrong. CONFIRM with the customer first. Needs the transaction id — call get_recent_transactions or list_alerts to find it.",
      parameters: {
        type: "object",
        properties: {
          transaction_id: { type: "string", description: "The id of the transaction to dispute." },
          reason: { type: "string", description: "Optional short reason, e.g. 'not recognized', 'duplicate charge'." },
        },
        required: ["transaction_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resolve_alert",
      description:
        "Resolve an alert MyFiat raised. action is 'recognized' (customer confirms it was them), 'confirmed_fraud' (customer does NOT recognize it), or 'dismiss'. CONFIRM with the customer first.",
      parameters: {
        type: "object",
        properties: {
          alert_id: { type: "string", description: "The id of the alert to resolve." },
          action: { type: "string", description: "recognized | confirmed_fraud | dismiss" },
        },
        required: ["alert_id", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_money",
      description:
        "Send money from the customer's checking account to a person or payee (e.g. 'send $50 to Jordan', 'pay Lumen Energy $120'). CONFIRM the payee and amount with the customer first.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Who to pay: a person's name or a payee/merchant name." },
          amount: { type: "number", description: "Amount in US dollars, e.g. 50 or 120.25." },
          note: { type: "string", description: "Optional memo." },
        },
        required: ["to", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_crypto_prices",
      description: "Live market prices (CoinGecko, refreshed every ~20s) and 24h change for the crypto MyFiat supports: BTC, ETH, SOL, ADA, DOGE, XRP, LTC, AVAX, LINK. Optionally pass symbol for one coin.",
      parameters: { type: "object", properties: { symbol: { type: "string", description: "Optional coin, e.g. BTC or bitcoin." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "buy_crypto",
      description:
        "Buy (or sell) crypto with the customer's checking account at the live price: BTC, ETH, SOL, ADA, DOGE, XRP, LTC, AVAX or LINK. Give EITHER amount_usd (e.g. 'buy $100 of bitcoin') OR quantity in coins. CONFIRM the coin, side and amount with the customer first.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "Ticker or name: BTC, ETH, SOL, ADA, DOGE, XRP, LTC, AVAX, LINK (bitcoin, ethereum, solana, cardano, dogecoin, ripple, litecoin, avalanche, chainlink)." },
          side: { type: "string", description: "buy (default) or sell." },
          amount_usd: { type: "number", description: "Dollar amount to buy/sell." },
          quantity: { type: "number", description: "Number of coins (alternative to amount_usd)." },
        },
        required: ["symbol"],
      },
    },
  },
];

// --- helpers ---------------------------------------------------------------
const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const lower = (s) => String(s || "").toLowerCase();
const COFFEE = /coffe|espresso|latte|starbucks|dunkin|cafe|café|roaster/i;
const daysUntil = (dateStr) => {
  if (!dateStr) return null;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 86400000);
};
const whenText = (dateStr) => {
  const d = daysUntil(dateStr);
  if (d == null) return "";
  if (d < 0) return `${-d} day(s) ago`;
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  return `in ${d} days`;
};

// Guess whether a subscription looks wasteful.
function wasteFlags(s) {
  const flags = [];
  if (s.price_increased || s.priceIncreased || (typeof s.previous_price_cents === "number" && typeof s.price_cents === "number" && s.price_cents > s.previous_price_cents)) {
    flags.push("price went up recently");
  }
  const used = s.last_used || s.lastUsed || s.last_used_at;
  const d = daysUntil(used);
  if (d != null && d < -60) flags.push("barely used in 2+ months");
  if (s.unused || s.inactive) flags.push("looks unused");
  if (s.duplicate) flags.push("possible duplicate");
  return flags;
}

const COIN_ALIASES = { BITCOIN: "BTC", ETHEREUM: "ETH", ETHER: "ETH", SOLANA: "SOL", CARDANO: "ADA", DOGECOIN: "DOGE",
  RIPPLE: "XRP", LITECOIN: "LTC", AVALANCHE: "AVAX", CHAINLINK: "LINK" };
const coinSymbol = (s) => { const raw = String(s || "").toUpperCase().replace(/[^A-Z]/g, ""); return COIN_ALIASES[raw] || raw; };

// --- dispatch --------------------------------------------------------------
export async function runTool(name, args, token) {
  // No signed-in identity this session — don't hit the API; say so plainly.
  if (!token) {
    return "I don't have access to your MyFiat account in this session, so I can't pull up your balances, transactions, cards, or subscriptions. You may need to sign in on the app — but I can still answer general questions.";
  }
  try {
    switch (name) {
      case "get_overview": {
        const me = await apiGet("/api/me", token).catch(() => null);
        const accounts = asList(await apiGet("/api/accounts", token), "accounts");
        const who = me ? label(me, "full_name", "name") || me.email : null;
        if (!accounts.length) return `${who ? `This is ${who}'s account. ` : ""}I couldn't find any accounts to show right now.`;
        const lines = accounts.map((a) => {
          const nm = label(a, "nickname", "name", "type") || "Account";
          const bal = usd(money(a, "balance", "available"));
          return `${nm}: ${bal}`;
        });
        const total = accounts.reduce((s, a) => s + (money(a, "balance", "available") || 0), 0);
        return `${who ? `${who} — ` : ""}total cash ${usd(total)} across ${accounts.length} account(s). ${lines.join("; ")}.`;
      }

      case "get_net_worth": {
        const accounts = asList(await apiGet("/api/accounts", token).catch(() => []), "accounts");
        const holdings = asList(await apiGet("/api/holdings", token).catch(() => []), "holdings");
        const cash = accounts.reduce((s, a) => s + (money(a, "balance", "available") || 0), 0);
        const invest = holdings.reduce((s, h) => s + (money(h, "value", "market_value") ?? (money(h, "price") || 0) * (h.quantity || h.shares || h.units || 0)), 0);
        if (!accounts.length && !holdings.length) return "I couldn't pull your accounts or holdings just now, so I can't total your net worth.";
        return `Net worth about ${usd(cash + invest)}: ${usd(cash)} in cash across ${accounts.length} account(s) and ${usd(invest)} in investments across ${holdings.length} holding(s).`;
      }

      case "get_recent_transactions": {
        const limit = num(args.limit, 10);
        let txs = asList(await apiGet("/api/transactions", token), "transactions");
        if (args.query) {
          const q = lower(args.query);
          txs = txs.filter((t) => lower(label(t, "merchant", "description") || JSON.stringify(t)).includes(q));
        }
        if (!txs.length) return args.query ? `No recent transactions match "${args.query}".` : "No recent transactions to show.";
        const lines = txs.slice(0, limit).map((t) => {
          const m = label(t, "merchant", "description") || "payment";
          const amt = usd(money(t, "amount"));
          const w = whenText(t.created_at || t.date || t.posted_at);
          return `${m} ${amt}${w ? ` ${w}` : ""}${t.status && t.status !== "succeeded" ? ` (${t.status})` : ""} [id ${t.id}]`;
        });
        return `${txs.length > limit ? `Showing ${limit} of ${txs.length}. ` : ""}${lines.join("; ")}.`;
      }

      case "get_spending_breakdown": {
        // Prefer MyFiat insights (may carry a category breakdown); fall back to summing transactions.
        const insights = await apiGet("/api/insights", token).catch(() => null);
        const txs = asList(await apiGet("/api/transactions", token).catch(() => []), "transactions");
        const cat = args.category ? lower(args.category) : null;

        if (cat) {
          const match = (t) => {
            const hay = lower(`${t.category || ""} ${label(t, "merchant", "description") || ""}`);
            if (cat.includes("coffee")) return COFFEE.test(hay);
            return hay.includes(cat);
          };
          const hits = txs.filter((t) => (money(t, "amount") || 0) < 0 || match(t)).filter(match);
          const total = hits.reduce((s, t) => s + Math.abs(money(t, "amount") || 0), 0);
          if (!hits.length) return `I don't see any spending tagged "${args.category}" in your recent transactions.`;
          return `You spent about ${usd(total)} on ${args.category} across ${hits.length} charge(s) recently: ${hits
            .slice(0, 6)
            .map((t) => `${label(t, "merchant", "description") || "charge"} ${usd(Math.abs(money(t, "amount") || 0))}`)
            .join(", ")}.`;
        }

        // Category breakdown.
        const byCat = {};
        for (const t of txs) {
          const amt = Math.abs(money(t, "amount") || 0);
          if (!amt) continue;
          const c = t.category || t.merchant_category || "Other";
          byCat[c] = (byCat[c] || 0) + amt;
        }
        const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
        if (!entries.length) {
          if (insights) return `Here's what MyFiat is highlighting: ${summarizeInsights(insights)}`;
          return "I couldn't build a spending breakdown — no recent transactions came back.";
        }
        const total = entries.reduce((s, [, v]) => s + v, 0);
        return `Recent spending is about ${usd(total)}. Top categories: ${entries
          .slice(0, 6)
          .map(([c, v]) => `${c} ${usd(v)}`)
          .join(", ")}.`;
      }

      case "get_insights": {
        const insights = await apiGet("/api/insights", token);
        const s = summarizeInsights(insights);
        return s || "MyFiat doesn't have any new insights for you right now.";
      }

      case "list_subscriptions": {
        const subs = asList(await apiGet("/api/subscriptions", token), "subscriptions");
        if (!subs.length) return "You don't have any active subscriptions on file.";
        const active = subs.filter((s) => (s.status || "active") !== "cancelled" && (s.status || "active") !== "canceled");
        const monthly = active.reduce((sum, s) => sum + monthlyCost(s), 0);
        const lines = active.map((s) => {
          const flags = wasteFlags(s);
          return `${label(s, "merchant", "name") || "Subscription"} ${usd(monthlyCost(s))}/mo${flags.length ? ` — ${flags.join(", ")}` : ""} [id ${s.id}]`;
        });
        const wasteful = active.filter((s) => wasteFlags(s).length);
        return `${active.length} active subscription(s), about ${usd(monthly)}/month. ${lines.join("; ")}.${
          wasteful.length ? ` Worth a look: ${wasteful.map((s) => label(s, "merchant", "name")).join(", ")}.` : ""
        }`;
      }

      case "get_upcoming_bills": {
        const days = num(args.days, 14);
        const subs = asList(await apiGet("/api/subscriptions", token), "subscriptions").filter(
          (s) => (s.status || "active") === "active",
        );
        const withDates = subs
          .map((s) => ({ s, d: daysUntil(s.next_charge || s.next_billing || s.next_charge_at || s.renews_at) }))
          .filter((x) => x.d != null && x.d >= 0 && x.d <= days)
          .sort((a, b) => a.d - b.d);
        if (!withDates.length) {
          const monthly = subs.reduce((sum, s) => sum + monthlyCost(s), 0);
          return subs.length
            ? `No bills have a due date in the next ${days} days (or dates weren't provided). Your recurring total is about ${usd(monthly)}/month.`
            : "No upcoming bills on file.";
        }
        const total = withDates.reduce((sum, x) => sum + monthlyCost(x.s), 0);
        return `In the next ${days} days: ${withDates
          .map((x) => `${label(x.s, "merchant", "name")} ${usd(monthlyCost(x.s))} ${whenText(x.s.next_charge || x.s.next_billing || x.s.renews_at)}`)
          .join("; ")}. About ${usd(total)} due.`;
      }

      case "get_portfolio": {
        const holdings = asList(await apiGet("/api/holdings", token), "holdings");
        if (!holdings.length) return "You don't have any investment holdings on file.";
        const enriched = holdings.map((h) => {
          const qty = h.quantity ?? h.shares ?? h.units ?? 0;
          const value = money(h, "value", "market_value") ?? (money(h, "price") || 0) * qty;
          const changePct =
            h.change_pct ?? h.changePct ?? h.day_change_pct ?? h.gain_pct ?? (typeof h.cost_basis_cents === "number" && value ? ((value - h.cost_basis_cents / 100) / (h.cost_basis_cents / 100)) * 100 : null);
          return { sym: h.symbol || h.ticker || label(h, "name") || "?", kind: h.kind || h.type || (h.crypto ? "crypto" : "stock"), value, changePct };
        });
        const total = enriched.reduce((s, h) => s + (h.value || 0), 0);
        const sorted = [...enriched].filter((h) => h.changePct != null).sort((a, b) => b.changePct - a.changePct);
        const fmtPct = (p) => (p == null ? "" : ` ${p >= 0 ? "+" : ""}${p.toFixed(1)}%`);
        const top = sorted[0];
        const bottom = sorted[sorted.length - 1];
        const stocks = enriched.filter((h) => lower(h.kind) !== "crypto");
        const crypto = enriched.filter((h) => lower(h.kind) === "crypto");
        return (
          `Portfolio is about ${usd(total)} across ${enriched.length} holding(s)` +
          `${stocks.length ? ` (${stocks.length} stock, ${crypto.length} crypto)` : ""}. ` +
          `${enriched.map((h) => `${h.sym} ${usd(h.value)}${fmtPct(h.changePct)}`).join(", ")}.` +
          (top && bottom && top !== bottom ? ` Best is ${top.sym}${fmtPct(top.changePct)}, worst is ${bottom.sym}${fmtPct(bottom.changePct)}.` : "")
        );
      }

      case "list_cards": {
        const cards = asList(await apiGet("/api/cards", token), "cards");
        if (!cards.length) return "You don't have any cards on file.";
        const lines = cards.map((c) => {
          const l4 = c.last4 || c.last_four || c.card_last4 || "????";
          const exp = c.expiry || c.exp || (c.exp_month && c.exp_year ? `${c.exp_month}/${c.exp_year}` : "");
          const status = c.status || (c.frozen ? "frozen" : "active");
          const nm = [label(c, "nickname", "name", "brand", "network") || "Card", c.kind].filter(Boolean).join(" ");
          const expSoon = isExpiringSoon(c);
          return `${nm} ending ${l4}${exp ? `, exp ${exp}` : ""} — ${status}${expSoon ? " (expiring soon)" : ""} [id ${c.id}]`;
        });
        return `${cards.length} card(s): ${lines.join("; ")}.`;
      }

      case "list_alerts": {
        const alerts = asList(await apiGet("/api/alerts", token), "alerts");
        const open = alerts.filter((a) => (a.status || "open") === "open" || !a.resolved);
        if (!open.length) return "No open alerts — you're all clear.";
        const lines = open.map((a) => {
          const kind = a.kind || a.type || "alert";
          const msg = label(a, "message", "title", "description") || kind;
          const amt = money(a, "amount");
          return `${kind}: ${msg}${amt != null ? ` (${usd(amt)})` : ""}${a.transaction_id || a.txId ? ` [tx ${a.transaction_id || a.txId}]` : ""} [alert ${a.id}]`;
        });
        return `${open.length} open alert(s): ${lines.join("; ")}.`;
      }

      // --- actions (confirm first; persona enforces) ---
      case "send_money": {
        const cents = Math.round(Number(args.amount) * 100);
        if (!(cents > 0)) return "I need a positive amount to send.";
        const r = await apiPost("/api/transfers", { to: args.to, amount_cents: cents, note: args.note || "" }, token);
        return `Sent ${usd(cents / 100)} to ${args.to} from ${r.from_account || "checking"}. New balance: ${usd((r.balance_cents_after ?? 0) / 100)}.`;
      }
      case "get_crypto_prices": {
        const { prices = [], source, as_of } = await apiGet("/api/crypto/prices", token);
        const want = coinSymbol(args.symbol);
        const rows = want ? prices.filter((p) => p.symbol === want) : prices;
        if (want && !rows.length) return `MyFiat doesn't support ${args.symbol}. Supported: ${prices.map((p) => p.symbol).join(", ")}.`;
        const when = as_of ? new Date(as_of).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "America/Chicago" }) : "just now";
        return `${source === "live" ? `Live prices as of ${when} Central` : "Prices (live feed unavailable, last known)"}: ` + rows.map((p) => `${p.name} (${p.symbol}) ${usd(p.price_cents / 100)}, ${p.change_24h_pct >= 0 ? "up" : "down"} ${Math.abs(p.change_24h_pct).toFixed(1)}% today`).join("; ");
      }
      case "buy_crypto": {
        const symbol = coinSymbol(args.symbol);
        const side = String(args.side || "buy").toLowerCase() === "sell" ? "sell" : "buy";
        let quantity = Number(args.quantity);
        if (!(quantity > 0)) {
          const { prices = [] } = await apiGet("/api/crypto/prices", token);
          const price = prices.find((p) => p.symbol === symbol)?.price_cents;
          if (!price) return `MyFiat doesn't support ${args.symbol}. You can trade ${prices.map((p) => p.symbol).join(", ")}.`;
          if (!(Number(args.amount_usd) > 0)) return "How much do you want to trade, in dollars or coins?";
          quantity = Math.floor((Number(args.amount_usd) * 100 / price) * 1e8) / 1e8;
        }
        const r = await apiPost("/api/trade", { asset_class: "crypto", symbol, side, quantity }, token);
        const f = r.fill || {};
        return `${side === "buy" ? "Bought" : "Sold"} ${f.quantity ?? quantity} ${symbol} at ${usd((f.price_cents ?? 0) / 100)} each (${usd(((f.price_cents ?? 0) * (f.quantity ?? quantity)) / 100)} total). Cash left in checking: ${usd((f.cash_cents_after ?? 0) / 100)}.`;
      }
      case "renew_card": {
        const r = await apiPost(`/api/cards/${encodeURIComponent(args.card_id)}/renew`, {}, token);
        return `Done — your replacement card is on the way. ${note(r)}`;
      }
      case "freeze_card": {
        const r = await apiPost(`/api/cards/${encodeURIComponent(args.card_id)}/freeze`, {}, token);
        return `Your card is frozen now — no new charges will go through. ${note(r)}`;
      }
      case "unfreeze_card": {
        const r = await apiPost(`/api/cards/${encodeURIComponent(args.card_id)}/unfreeze`, {}, token);
        return `Your card is active again and ready to use. ${note(r)}`;
      }
      case "cancel_subscription": {
        const r = await apiPost(`/api/subscriptions/${encodeURIComponent(args.subscription_id)}/cancel`, {}, token);
        return `Cancelled — you won't be billed for that again. ${note(r)}`;
      }
      case "dispute_charge": {
        const r = await apiPost(`/api/transactions/${encodeURIComponent(args.transaction_id)}/dispute`, { reason: args.reason || "not recognized" }, token);
        return `I've opened a dispute on that charge; our team will investigate and you're protected while we do. ${note(r)}`;
      }
      case "resolve_alert": {
        const action = args.action || "dismiss";
        const r = await apiPost(`/api/alerts/${encodeURIComponent(args.alert_id)}/resolve`, { action }, token);
        const msg =
          action === "recognized"
            ? "Marked that alert as recognized — glad it was you."
            : action === "confirmed_fraud"
              ? "Marked that alert as confirmed fraud."
              : "Dismissed that alert.";
        return `${msg} ${note(r)}`;
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    if (err instanceof ApiDownError) {
      return `I couldn't reach MyFiat just now (${err.message}), so I can't ${verbFor(name)} this second. Want me to try again in a moment?`;
    }
    if (err && err.status === 401) {
      return "Your session looks expired, so I can't access your account — you may need to sign in again.";
    }
    if (err && err.status === 404) {
      return `I couldn't find that ${name.includes("card") ? "card" : name.includes("sub") ? "subscription" : name.includes("alert") ? "alert" : "item"} — let me pull the list so we grab the right one.`;
    }
    return `That didn't go through (${err.message}). Nothing was changed; want me to try again?`;
  }
}

function note(r) {
  if (r && typeof r === "object") {
    const m = r.message || r.note || r.status;
    if (m && typeof m === "string") return "";
  }
  return "";
}

function verbFor(name) {
  const map = {
    get_overview: "pull your balances",
    get_net_worth: "total your net worth",
    get_recent_transactions: "pull your transactions",
    get_spending_breakdown: "break down your spending",
    get_insights: "pull your insights",
    list_subscriptions: "list your subscriptions",
    get_upcoming_bills: "list your upcoming bills",
    get_portfolio: "pull your portfolio",
    list_cards: "list your cards",
    list_alerts: "check your alerts",
    renew_card: "renew the card",
    freeze_card: "freeze the card",
    unfreeze_card: "unfreeze the card",
    cancel_subscription: "cancel the subscription",
    dispute_charge: "open the dispute",
    resolve_alert: "resolve the alert",
  };
  return map[name] || "do that";
}

function monthlyCost(s) {
  const amt = money(s, "amount", "price", "cost") || 0;
  const cycle = lower(s.cycle || s.interval || s.frequency || s.billing_cycle || "monthly");
  if (cycle.includes("year") || cycle.includes("annual")) return amt / 12;
  if (cycle.includes("week")) return amt * 4.33;
  if (cycle.includes("quarter")) return amt / 3;
  return amt; // assume monthly
}

function isExpiringSoon(c) {
  if (c.expiring_soon || c.expiringSoon) return true;
  const mo = c.exp_month || c.expiry_month;
  const yr = c.exp_year || c.expiry_year;
  if (mo && yr) {
    const exp = new Date(Number(yr) < 100 ? 2000 + Number(yr) : Number(yr), Number(mo), 0);
    return (exp - Date.now()) / 86400000 < 60;
  }
  if (typeof c.expiry === "string") {
    const m = c.expiry.match(/(\d{1,2})\s*\/\s*(\d{2,4})/);
    if (m) {
      const y = Number(m[2]) < 100 ? 2000 + Number(m[2]) : Number(m[2]);
      const exp = new Date(y, Number(m[1]), 0);
      return (exp - Date.now()) / 86400000 < 60;
    }
  }
  return false;
}

function summarizeInsights(insights) {
  const list = asList(insights, "insights", "items");
  if (list.length) {
    return list
      .slice(0, 5)
      .map((i) => label(i, "message", "title", "text", "summary") || (typeof i === "string" ? i : JSON.stringify(i)))
      .join("; ");
  }
  if (insights && typeof insights === "object") {
    const parts = [];
    for (const [k, v] of Object.entries(insights)) {
      if (typeof v === "string" || typeof v === "number") parts.push(`${k}: ${v}`);
    }
    if (parts.length) return parts.slice(0, 6).join("; ");
  }
  return "";
}

// Find a suspicious-charge alert for the outbound call. Returns a normalized
// object the voice prompt can use, or null.
export async function findSuspiciousCharge(token) {
  const alerts = asList(await apiGet("/api/alerts", token), "alerts");
  const susp =
    alerts.find((a) => lower(a.kind || a.type) === "suspicious_charge" && (a.status || "open") === "open") ||
    alerts.find((a) => lower(a.kind || a.type) === "suspicious_charge") ||
    alerts.find((a) => /suspicious|fraud|unusual/i.test(lower(a.kind || a.type || a.message)));
  if (!susp) return null;

  let tx = null;
  const txId = susp.transaction_id || susp.txId || susp.tx_id;
  if (txId) {
    const txs = asList(await apiGet("/api/transactions", token).catch(() => []), "transactions");
    tx = txs.find((t) => String(t.id) === String(txId)) || null;
  }
  const amt = money(susp, "amount") ?? (tx ? money(tx, "amount") : null);
  return {
    alertId: susp.id,
    txId: txId || tx?.id || null,
    merchant: label(susp, "merchant") || (tx ? label(tx, "merchant", "description") : null),
    amount: amt != null ? usd(Math.abs(amt)) : null,
    last4: susp.card_last4 || susp.last4 || (tx && (tx.card_last4 || tx.last4)) || null,
    cardId: susp.card_id || (tx && tx.card_id) || null,
    when: whenText(susp.created_at || tx?.created_at || tx?.date),
    raw: susp,
  };
}
