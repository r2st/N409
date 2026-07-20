"""Guideline-public-company reference data for the market approach.

The comparable-company AI agent proposes tickers; before those multiples are
allowed to influence a valuation they are verified here: an unknown ticker is
rejected outright, and a known one is answered with its SIC classification,
market capitalisation, and trading multiples so the agent (and the analyst)
work from real figures rather than a model's guess.

There is no live market-data vendor wired into the platform, so this is a
curated static snapshot of well-known, liquid public companies — enough to
anchor comp selection and to keep the pipeline deterministic and testable
offline. Every figure is an illustrative reference point, not a real-time
quote; callers must surface it as such. Multiples are enterprise-value based
(EV/Revenue, EV/EBITDA); ``ev_ebitda`` is null for companies whose EBITDA is
negative or not meaningfully positive, which is common for high-growth names.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from .errors import EngineInputError


@dataclass(frozen=True)
class Company:
    ticker: str
    name: str
    sic_code: str
    sic_description: str
    sector: str
    market_cap: float  # USD, illustrative snapshot
    ev_revenue: float  # EV / LTM revenue
    ev_ebitda: float | None  # EV / LTM EBITDA; None when EBITDA is not positive

    def to_dict(self) -> dict:
        return asdict(self)


# Illustrative snapshot. Ordered roughly by sector for readability; lookup is by
# ticker so order is irrelevant at runtime.
_COMPANIES: tuple[Company, ...] = (
    # ── Application / infrastructure SaaS (SIC 7372 prepackaged software) ──────
    Company("DDOG", "Datadog, Inc.", "7372", "Prepackaged Software", "Observability SaaS", 42_000_000_000, 14.2, 78.0),
    Company("DT", "Dynatrace, Inc.", "7372", "Prepackaged Software", "Observability SaaS", 15_000_000_000, 10.1, 42.0),
    Company("SNOW", "Snowflake Inc.", "7372", "Prepackaged Software", "Data Cloud", 55_000_000_000, 16.8, None),
    Company("MDB", "MongoDB, Inc.", "7372", "Prepackaged Software", "Database SaaS", 20_000_000_000, 12.5, None),
    Company("CRM", "Salesforce, Inc.", "7372", "Prepackaged Software", "CRM SaaS", 250_000_000_000, 7.4, 32.0),
    Company("NOW", "ServiceNow, Inc.", "7372", "Prepackaged Software", "Workflow SaaS", 155_000_000_000, 16.0, 62.0),
    Company("TEAM", "Atlassian Corporation", "7372", "Prepackaged Software", "Dev Collaboration", 50_000_000_000, 12.0, None),
    Company("ZS", "Zscaler, Inc.", "7372", "Prepackaged Software", "Cloud Security", 28_000_000_000, 13.0, None),
    Company("CRWD", "CrowdStrike Holdings, Inc.", "7372", "Prepackaged Software", "Endpoint Security", 75_000_000_000, 18.5, None),
    Company("OKTA", "Okta, Inc.", "7372", "Prepackaged Software", "Identity SaaS", 15_000_000_000, 6.5, None),
    Company("HUBS", "HubSpot, Inc.", "7372", "Prepackaged Software", "Marketing SaaS", 30_000_000_000, 12.2, None),
    Company("TWLO", "Twilio Inc.", "7372", "Prepackaged Software", "Communications API", 11_000_000_000, 2.6, None),
    Company("ZM", "Zoom Video Communications, Inc.", "7372", "Prepackaged Software", "Video SaaS", 21_000_000_000, 4.6, 18.0),
    Company("DOCU", "DocuSign, Inc.", "7372", "Prepackaged Software", "eSignature SaaS", 12_000_000_000, 4.4, 22.0),
    Company("SHOP", "Shopify Inc.", "7372", "Prepackaged Software", "Commerce Platform", 90_000_000_000, 12.9, None),
    # ── Fintech / payments (SIC 7389 services-computer / 6199 finance) ─────────
    Company("SQ", "Block, Inc.", "7389", "Computer Related Services", "Payments Fintech", 40_000_000_000, 2.1, 28.0),
    Company("PYPL", "PayPal Holdings, Inc.", "7389", "Computer Related Services", "Payments Fintech", 65_000_000_000, 2.3, 11.0),
    Company("ADYEY", "Adyen N.V.", "7389", "Computer Related Services", "Payments Fintech", 45_000_000_000, 20.0, 38.0),
    Company("COIN", "Coinbase Global, Inc.", "6199", "Finance Services", "Crypto Exchange", 55_000_000_000, 7.5, 24.0),
    Company("AFRM", "Affirm Holdings, Inc.", "6199", "Finance Services", "BNPL Fintech", 12_000_000_000, 5.0, None),
    # ── E-commerce / marketplaces (SIC 5961 catalog & mail-order) ─────────────
    Company("AMZN", "Amazon.com, Inc.", "5961", "Catalog & Mail-Order Houses", "E-commerce", 1_800_000_000_000, 3.1, 20.0),
    Company("ETSY", "Etsy, Inc.", "5961", "Catalog & Mail-Order Houses", "E-commerce Marketplace", 7_000_000_000, 2.7, 12.0),
    Company("EBAY", "eBay Inc.", "5961", "Catalog & Mail-Order Houses", "E-commerce Marketplace", 25_000_000_000, 2.5, 9.5),
    Company("CHWY", "Chewy, Inc.", "5961", "Catalog & Mail-Order Houses", "Pet E-commerce", 12_000_000_000, 1.1, 30.0),
    # ── Semiconductors (SIC 3674) ─────────────────────────────────────────────
    Company("NVDA", "NVIDIA Corporation", "3674", "Semiconductors & Related Devices", "Semiconductors", 2_200_000_000_000, 30.0, 55.0),
    Company("AMD", "Advanced Micro Devices, Inc.", "3674", "Semiconductors & Related Devices", "Semiconductors", 260_000_000_000, 11.0, 45.0),
    Company("AVGO", "Broadcom Inc.", "3674", "Semiconductors & Related Devices", "Semiconductors", 600_000_000_000, 15.0, 28.0),
    # ── Biotech / pharma (SIC 2836 biological products, 2834 pharma) ──────────
    Company("MRNA", "Moderna, Inc.", "2836", "Biological Products", "Biotechnology", 40_000_000_000, 6.0, 14.0),
    Company("VRTX", "Vertex Pharmaceuticals Incorporated", "2836", "Biological Products", "Biotechnology", 110_000_000_000, 11.0, 26.0),
    Company("REGN", "Regeneron Pharmaceuticals, Inc.", "2836", "Biological Products", "Biotechnology", 100_000_000_000, 8.5, 20.0),
    # ── Consumer internet / media (SIC 7370 computer services) ────────────────
    Company("NFLX", "Netflix, Inc.", "7841", "Video Tape Rental", "Streaming Media", 250_000_000_000, 7.2, 34.0),
    Company("SPOT", "Spotify Technology S.A.", "7900", "Services-Amusement & Recreation", "Audio Streaming", 60_000_000_000, 4.0, 60.0),
    Company("UBER", "Uber Technologies, Inc.", "4700", "Transportation Services", "Mobility Marketplace", 150_000_000_000, 4.5, 40.0),
    Company("ABNB", "Airbnb, Inc.", "7011", "Hotels & Motels", "Travel Marketplace", 90_000_000_000, 9.0, 30.0),
    Company("DASH", "DoorDash, Inc.", "5812", "Eating Places", "Delivery Marketplace", 50_000_000_000, 5.5, None),
)

_BY_TICKER: dict[str, Company] = {c.ticker: c for c in _COMPANIES}

MAX_TICKERS = 50


def normalize_ticker(raw: object) -> str:
    """Upper-cases and strips a candidate ticker; drops an exchange prefix like
    ``NASDAQ:DDOG`` that models sometimes emit."""
    text = str(raw or "").strip().upper()
    if ":" in text:
        text = text.rsplit(":", 1)[-1].strip()
    return text


def lookup(tickers: object) -> dict:
    """Verify a list of proposed tickers.

    Returns ``{"companies": [...verified...], "not_found": [...], "count": n}``.
    Duplicates and blanks are collapsed; order follows first appearance so the
    caller can zip the result back against its request. Unknown tickers are the
    signal the agent uses to drop a hallucinated comp.
    """
    if not isinstance(tickers, list):
        raise EngineInputError("market-data: 'tickers' must be a list")
    if len(tickers) > MAX_TICKERS:
        raise EngineInputError(f"market-data: at most {MAX_TICKERS} tickers per request")

    companies: list[dict] = []
    not_found: list[str] = []
    seen: set[str] = set()
    for raw in tickers:
        symbol = normalize_ticker(raw)
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        company = _BY_TICKER.get(symbol)
        if company is None:
            not_found.append(symbol)
        else:
            companies.append(company.to_dict())
    return {"companies": companies, "not_found": not_found, "count": len(companies)}


def universe() -> list[dict]:
    """The full reference set — used by the /market-data GET probe and tests."""
    return [c.to_dict() for c in _COMPANIES]
