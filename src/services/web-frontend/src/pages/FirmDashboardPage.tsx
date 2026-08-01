import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDate } from '../lib/format';
import {
  DataTable,
  EmptyState,
  ErrorNote,
  Pagination,
  pageCountOf,
  Spinner,
  StatCard,
  StateBadge,
  TableSkeleton,
  TextInput,
  type Column,
} from '../components/ui';
import { IntakeLinksPanel } from '../components/IntakeLinksPanel';
import type { ValuationState } from '../lib/types';

/**
 * Firm console — a valuation firm's whole book on one page.
 *
 * The organising idea is that a principal running eighty live engagements does
 * not want a list of eighty. The page leads with the triage queue the API
 * ranked (late, unowned, stuck), then workload by reviewer, then the client
 * roster. Every number here is aggregated server-side and scoped to the firm.
 */

type AttentionReason = 'overdue' | 'unassigned' | 'stalled_with_client' | 'stalled_in_review' | 'due_soon';

interface AttentionItem {
  id: string;
  number: number;
  company_name: string;
  state: ValuationState;
  due_date: string | null;
  assigned_reviewer_name: string | null;
  reason: AttentionReason;
  severity: 'high' | 'medium';
  days: number;
  detail: string;
}

interface TeamMember {
  user_id: string;
  name: string | null;
  email: string;
  assigned: number;
  active: number;
  overdue: number;
}

interface FirmDashboard {
  firm: { id: string; name: string };
  summary: {
    total: number;
    active: number;
    published: number;
    closed: number;
    waiting_on_client: number;
    overdue: number;
    due_soon: number;
    unassigned: number;
    by_state: Record<string, number>;
  };
  team: TeamMember[];
  attention: AttentionItem[];
  attention_total: number;
  attention_counts: Record<AttentionReason, number>;
}

interface FirmClient {
  company_name: string;
  engagements: number;
  active: number;
  latest_valuation_id: string;
  latest_state: ValuationState;
  latest_created_at: string;
  next_due_date: string | null;
  last_published_at: string | null;
}

const REASON_LABELS: Record<AttentionReason, string> = {
  overdue: 'Overdue',
  unassigned: 'Unassigned',
  stalled_with_client: 'Stalled with client',
  stalled_in_review: 'Stalled in review',
  due_soon: 'Due soon',
};

const CLIENTS_PER_PAGE = 10;

function SeverityDot({ severity }: { severity: 'high' | 'medium' }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 rounded-full ${severity === 'high' ? 'bg-red-500' : 'bg-amber-400'}`}
    />
  );
}

export function FirmDashboardPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // Firm users get their own console from the session. Ops belong to no firm,
  // so they arrive from the partner console with the tenant named in the URL.
  const partnerId = params.get('partner_id');

  const [data, setData] = useState<FirmDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [clients, setClients] = useState<FirmClient[] | null>(null);
  const [clientTotal, setClientTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const path = partnerId
      ? `/firm/dashboard?partner_id=${encodeURIComponent(partnerId)}`
      : '/firm/dashboard';
    api<FirmDashboard>(path)
      .then(setData)
      .catch((err) =>
        setError(
          err instanceof ApiError && err.status === 403
            ? 'The firm console is available to firm accounts.'
            : err instanceof ApiError && err.status === 400
              ? 'Open a firm from the partner console to see its book.'
              : 'Could not load the firm console.',
        ),
      );
  }, [partnerId]);

  const loadClients = useCallback(
    async (nextPage: number, term: string) => {
      const query = new URLSearchParams({ page: String(nextPage), per_page: String(CLIENTS_PER_PAGE) });
      if (term.trim()) query.set('search', term.trim());
      if (partnerId) query.set('partner_id', partnerId);
      const res = await api<{ clients: FirmClient[]; total: number }>(`/firm/clients?${query}`);
      setClients(res.clients);
      setClientTotal(res.total);
    },
    [partnerId],
  );

  // Debounced so typing a client name is one request per pause, not per key.
  useEffect(() => {
    const timer = setTimeout(() => {
      loadClients(page, search).catch(() => setClients([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [page, search, loadClients]);

  if (error && !data) return <ErrorNote>{error}</ErrorNote>;
  if (!data) return <Spinner />;

  const { summary, attention, team } = data;

  const attentionColumns: Column<AttentionItem>[] = [
    {
      key: 'company',
      header: 'Client',
      render: (row) => (
        <span className="flex items-center gap-2">
          <SeverityDot severity={row.severity} />
          <span className="font-medium text-ink-900">{row.company_name}</span>
          <span className="tnum text-xs text-ink-400">#{row.number}</span>
        </span>
      ),
    },
    {
      key: 'reason',
      header: 'Needs attention',
      render: (row) => (
        <span>
          <span className="font-medium text-ink-800">{REASON_LABELS[row.reason]}</span>
          <span className="block text-xs text-ink-400">{row.detail}</span>
        </span>
      ),
    },
    { key: 'state', header: 'Stage', render: (row) => <StateBadge state={row.state} /> },
    {
      key: 'reviewer',
      header: 'Reviewer',
      render: (row) => row.assigned_reviewer_name ?? <span className="text-ink-400">Nobody assigned</span>,
    },
    {
      key: 'due',
      header: 'Due',
      align: 'right',
      render: (row) => (row.due_date ? formatDate(row.due_date) : <span className="text-ink-400">—</span>),
    },
  ];

  const teamColumns: Column<TeamMember>[] = [
    { key: 'name', header: 'Reviewer', render: (row) => row.name ?? row.email },
    {
      key: 'active',
      header: 'Live',
      align: 'right',
      render: (row) => <span className="tnum">{row.active}</span>,
    },
    {
      key: 'overdue',
      header: 'Overdue',
      align: 'right',
      render: (row) => (
        <span className={`tnum ${row.overdue > 0 ? 'font-semibold text-red-600' : 'text-ink-400'}`}>
          {row.overdue}
        </span>
      ),
    },
    {
      key: 'assigned',
      header: 'All time',
      align: 'right',
      render: (row) => <span className="tnum text-ink-400">{row.assigned}</span>,
    },
  ];

  const clientColumns: Column<FirmClient>[] = [
    {
      key: 'company_name',
      header: 'Client',
      render: (row) => <span className="font-medium text-ink-900">{row.company_name}</span>,
    },
    {
      key: 'engagements',
      header: 'Engagements',
      align: 'right',
      render: (row) => (
        <span className="tnum">
          {row.active > 0 ? `${row.active} live / ` : ''}
          {row.engagements}
        </span>
      ),
    },
    { key: 'latest_state', header: 'Latest', render: (row) => <StateBadge state={row.latest_state} /> },
    {
      key: 'next_due_date',
      header: 'Next due',
      align: 'right',
      render: (row) =>
        row.next_due_date ? formatDate(row.next_due_date) : <span className="text-ink-400">—</span>,
    },
    {
      key: 'last_published_at',
      header: 'Last delivered',
      align: 'right',
      render: (row) =>
        row.last_published_at ? formatDate(row.last_published_at) : <span className="text-ink-400">—</span>,
    },
  ];

  return (
    <div>
      <div className="overline text-ink-400">Firm console</div>
      <h1 className="mt-1 font-display text-3xl font-semibold text-ink-900">{data.firm.name}</h1>
      <p className="mt-1 text-sm text-ink-400">Every client engagement your firm is running, in one place.</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Live engagements" value={summary.active} accent />
        <StatCard label="Overdue" value={summary.overdue} />
        <StatCard label="Due in 7 days" value={summary.due_soon} />
        <StatCard label="Waiting on client" value={summary.waiting_on_client} />
        <StatCard label="Unassigned" value={summary.unassigned} />
      </div>

      <section className="mt-10">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-xl font-semibold text-ink-900">Needs attention</h2>
          {data.attention_total > attention.length && (
            <span className="text-sm text-ink-400">
              Showing {attention.length} of {data.attention_total}
            </span>
          )}
        </div>
        <div className="mt-3 rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
          <DataTable
            columns={attentionColumns}
            rows={attention}
            rowKey={(row) => row.id}
            caption="Engagements needing attention"
            onRowClick={(row) => navigate(`/valuations/${row.id}`)}
            empty={
              <EmptyState title="Nothing needs chasing">
                No engagement is overdue, unowned or stalled.
              </EmptyState>
            }
          />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="font-display text-xl font-semibold text-ink-900">Reviewer workload</h2>
        <div className="mt-3 rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
          <DataTable
            columns={teamColumns}
            rows={team}
            rowKey={(row) => row.user_id}
            caption="Workload by reviewer"
            empty="No engagement has a reviewer assigned yet."
          />
        </div>
      </section>

      <section className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-xl font-semibold text-ink-900">Clients</h2>
          <div className="w-full max-w-xs">
            <TextInput
              type="search"
              aria-label="Search clients"
              placeholder="Search clients…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-paper-300 bg-surface p-2 shadow-card">
          {clients === null ? (
            <TableSkeleton columns={clientColumns.length} rows={6} label="Loading clients…" />
          ) : (
            <DataTable
              columns={clientColumns}
              rows={clients}
              rowKey={(row) => row.company_name}
              caption="Clients"
              onRowClick={(row) => navigate(`/valuations/${row.latest_valuation_id}`)}
              empty={search ? `No client matches “${search}”.` : 'No clients yet.'}
            />
          )}
        </div>
        <Pagination
          className="mt-4"
          page={page}
          pageCount={pageCountOf(clientTotal, CLIENTS_PER_PAGE)}
          onPage={setPage}
        />
      </section>

      <IntakeLinksPanel partnerId={partnerId} />

      <p className="mt-10 text-sm text-ink-400">
        Looking for a single engagement?{' '}
        <Link to="/valuations" className="text-bond-700 underline">
          Browse all valuations
        </Link>
        .
      </p>
    </div>
  );
}
