# N409 vs 409.ai — Feature Gap Analysis

## What N409 Already Has (8 features)
- Login with email/password + Google SSO stub
- User registration with RBAC
- Dashboard with stat cards
- Valuations list with state/kind filters and pagination
- New valuation creation (all 13 kinds)
- Valuation detail with role-gated editing
- Audit event timeline
- Settings/profile page

## What's Missing: 32 Features Across 3 Priority Tiers

### P0 Critical — 9 gaps (blocks core valuation workflow)

1. **Review / task management system** — The entire analyst → reviewer → signer → publish pipeline. 409.ai has 5,700+ typed review tasks with assignment, SLA, overdue tracking. N409 has nothing.
2. **AI document ingestion & extraction** — Upload by document type, AI pipelines (Missing Data, Data Extraction, Public Comparables), AI actions (Find Mappings, Set Params, Summarize). Zero AI in N409.
3. **AI prompt registry with multi-model routing** — 27+ prompts bound to Perplexity, Bedrock Llama/Claude, Anthropic Opus. No prompt management in N409. Use OpenRouter free models.
4. **Valuation Params (finance methodology editor)** — Approach weights (Asset/OPM/Income/Market), DLOM (Chaffee/Finnerty), DLOC, revenue status, exit timeline. Not built.
5. **R calculation engine integration** — The actual compute layer (OPM/Black-Scholes, income/market/asset approaches, sensitivity). N409 has no compute.
6. **Report editor + PDF generation + versions** — WYSIWYG editor, PDF rendering, version history. N409 can't produce any deliverable.
7. **Valuation workbook** — Per-valuation working model/spreadsheet.
8. **Overwrites system (68 fields)** — Manual analyst overrides across 6 categories with schema explorer.
9. **Document upload / attachment management** — Per-valuation file handling organized by type.

### P1 Important — 15 gaps (operational efficiency)

10. Email inbox → valuation comment threading
11. Per-valuation client chat + sticky notes
12. Partner portal with partner-scoped views (323 partner valuations in production)
13. User/role admin console (1,310 users, ~15 role types)
14. API token management for partners
15. Advanced filtering (ID/UUID/Workflow ID, reviewer, partner, source, date ranges) + tabbed scopes with live counts
16. CSV export on valuations + users lists
17. Dashboard product pivot table + pie chart + date-range search
18. Clone / roll-forward valuation
19. Sensitivity dashboard (OPM stress tables)
20. Report template management (versioned templates like 409a.v53)
21. Auto email workflows
22. Workflow engine (restart, reassign, auto-advance)
23. Bulk actions on valuations
24. Transaction & funding-round history per valuation

### P2 Nice-to-have — 8 gaps

25. Package explorer
26. Overwrites schema browser
27. Notification badges/unread counts
28. Marketing attribution (gclid)
29. Intercom widget / live chat
30. Rich sort controls
31. Payment processing (Stripe)
32. Global search

## Key Takeaway

N409 currently covers the "shell" — auth, CRUD, and basic list/detail views — but lacks the entire valuation production pipeline: document intake → AI extraction → methodology config → engine computation → report generation → review/sign/publish. That pipeline IS the product.

## Recommended Implementation Order

### Milestone 1: Core Pipeline (P0 items 1-5)
- Review/task management system
- Document upload and management
- AI document ingestion with OpenRouter
- Valuation params editor
- Calculation engine (Python reimplementation of R engine)

### Milestone 2: Output & Delivery (P0 items 6-9)
- Report editor and PDF generation
- Valuation workbook
- Overwrites system

### Milestone 3: Operations (P1 items 10-18)
- Partner portal
- Admin console
- Advanced filtering and export
- Clone/roll-forward
- Dashboard analytics

### Milestone 4: Polish (P1 items 19-24, P2)
- Workflow engine
- Sensitivity dashboard
- Email workflows
- Remaining P2 features
