import { useState } from 'react';

const GOLD = '#D4AF37';
const GOLD_LIGHT = '#E8C65A';

interface TimelineStep {
  id: string;
  label: string;
  duration: string;
  description: string;
  details: string[];
}

const STEPS: TimelineStep[] = [
  {
    id: 'engagement',
    label: 'Engagement',
    duration: 'Day 1',
    description: 'Kick off your valuation with a simple order and intake questionnaire.',
    details: [
      'Select your valuation type and delivery speed',
      'AI-guided intake collects company basics',
      'Cap table upload or manual entry',
      'Secure payment and engagement letter',
    ],
  },
  {
    id: 'data-collection',
    label: 'Data collection',
    duration: 'Days 1–3',
    description: 'We gather and verify the financial data needed for your valuation.',
    details: [
      'Financial statements and projections review',
      'Funding history and term sheet analysis',
      'Comparable company identification',
      'Automated data validation and cross-checks',
    ],
  },
  {
    id: 'analysis',
    label: 'Analysis',
    duration: 'Days 3–7',
    description: 'AI engine runs multiple valuation approaches, reconciled by our analysts.',
    details: [
      'Market, income, and asset approach calculations',
      'OPM backsolve and option pricing models',
      'DLOM analysis (Finnerty and Chaffee models)',
      'Multi-scenario sensitivity testing',
    ],
  },
  {
    id: 'draft-report',
    label: 'Draft report',
    duration: 'Days 7–10',
    description: 'A credentialed analyst reviews the output and prepares your draft.',
    details: [
      'Analyst sign-off on methodology and conclusions',
      'Board-ready PDF with full methodology appendix',
      'Draft shared for your review and comments',
      'Revisions addressed within 24 hours',
    ],
  },
  {
    id: 'final-report',
    label: 'Final report',
    duration: 'Days 10–14',
    description: 'Your audit-defensible report is delivered, ready for board approval.',
    details: [
      'Final PDF report with analyst signature',
      'IRS safe-harbor qualified documentation',
      'Board resolution template included',
      'Ongoing audit support at no extra charge',
    ],
  },
];

export function ValuationTimeline() {
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  return (
    <div className="landing-timeline" data-testid="valuation-timeline">
      <h2
        className="landing-timeline-heading"
        style={{ color: GOLD_LIGHT, fontFamily: "'IBM Plex Sans', system-ui, sans-serif" }}
      >
        How your 409A valuation works
      </h2>
      <p className="landing-timeline-subhead">
        Average: 2–3 weeks from engagement to final report
      </p>

      <div className="landing-timeline-track">
        {STEPS.map((step, i) => {
          const isExpanded = expandedStep === step.id;
          const isLast = i === STEPS.length - 1;

          return (
            <div key={step.id} className="landing-timeline-step" data-testid={`timeline-step-${step.id}`}>
              {/* Connector line */}
              {!isLast && <div className="landing-timeline-connector" />}

              <button
                type="button"
                className="landing-timeline-node"
                onClick={() => setExpandedStep(isExpanded ? null : step.id)}
                aria-expanded={isExpanded}
                aria-controls={`timeline-detail-${step.id}`}
              >
                <div className="landing-timeline-dot" style={{ borderColor: GOLD }}>
                  <span className="landing-timeline-dot-num">{i + 1}</span>
                </div>
                <div className="landing-timeline-label">
                  <span className="landing-timeline-name">{step.label}</span>
                  <span className="landing-timeline-duration">{step.duration}</span>
                </div>
                <svg
                  className={`landing-timeline-chevron${isExpanded ? ' landing-timeline-chevron-open' : ''}`}
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {isExpanded && (
                <div
                  id={`timeline-detail-${step.id}`}
                  className="landing-timeline-detail"
                  role="region"
                  aria-label={`${step.label} details`}
                >
                  <p className="landing-timeline-desc">{step.description}</p>
                  <ul className="landing-timeline-list">
                    {step.details.map((d) => (
                      <li key={d}>
                        <span style={{ color: GOLD }} aria-hidden="true">→</span> {d}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Animated progress bar */}
      <div className="landing-timeline-progress">
        <div className="landing-timeline-progress-bar" />
        <span className="landing-timeline-progress-label">Average: 2–3 weeks</span>
      </div>
    </div>
  );
}
