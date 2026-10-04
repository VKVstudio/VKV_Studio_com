/** Dated results from public, independent checks of the live site. */
interface AuditCapture {
  src: string;
  width: number;
  height: number;
  mode?: 'mobile' | 'desktop';
  scores?: readonly { labelKey: string; value: string }[];
}

export interface AuditProof {
  id: 'tls' | 'headers' | 'browser' | 'pagespeed';
  source: string;
  grade: 'A+' | '100' | '6/6';
  scannedAt: string;
  reportUrl: string;
  captures: readonly AuditCapture[];
  gradeContextKey: string;
  hookKey: string;
  descriptionKey: string;
  scoreKeys?: readonly string[];
}

export const AUDIT_PROOFS: readonly AuditProof[] = [
  {
    id: 'tls',
    source: 'Qualys SSL Labs',
    grade: 'A+',
    gradeContextKey: 'auditProof.gradeContext.tls',
    hookKey: 'auditProof.hooks.tls',
    descriptionKey: 'auditProof.descriptions.tls',
    scannedAt: '2026-10-04T16:48:15Z',
    reportUrl: 'https://www.ssllabs.com/ssltest/analyze.html?d=vkvstudio.com&hideResults=on&latest',
    captures: [
      {
        src: '/audit-proofs/2026-10-04/ssl-labs-summary-v3.jpg',
        width: 1102,
        height: 675,
      },
    ],
  },
  {
    id: 'headers',
    source: 'SecurityHeaders.com',
    grade: 'A+',
    gradeContextKey: 'auditProof.gradeContext.headers',
    hookKey: 'auditProof.hooks.headers',
    descriptionKey: 'auditProof.descriptions.headers',
    scannedAt: '2026-10-03T20:17:44Z',
    reportUrl:
      'https://securityheaders.com/?q=https%3A%2F%2Fvkvstudio.com%2Fen%2F&hide=on&followRedirects=on',
    captures: [
      {
        src: '/audit-proofs/2026-10-04/securityheaders.jpg',
        width: 1692,
        height: 868,
      },
    ],
  },
  {
    id: 'browser',
    source: 'Mozilla Observatory',
    grade: 'A+',
    gradeContextKey: 'auditProof.gradeContext.browser',
    hookKey: 'auditProof.hooks.browser',
    descriptionKey: 'auditProof.descriptions.browser',
    scannedAt: '2026-10-03T20:18:00Z',
    reportUrl:
      'https://developer.mozilla.org/en-US/observatory/analyze?host=vkvstudio.com%2Fen%2F#scoring',
    captures: [
      {
        src: '/audit-proofs/2026-10-04/mozilla-observatory.jpg',
        width: 1692,
        height: 868,
      },
    ],
  },
  {
    id: 'pagespeed',
    source: 'Google PageSpeed Insights',
    grade: '6/6',
    gradeContextKey: 'auditProof.gradeContext.pagespeed',
    hookKey: 'auditProof.hooks.pagespeed',
    descriptionKey: 'auditProof.descriptions.pagespeed',
    scannedAt: '2026-10-03T20:31:20Z',
    reportUrl:
      'https://pagespeed.web.dev/analysis/https-vkvstudio-com-en/lgvn1qn9a2?form_factor=desktop&hl=en',
    captures: [
      {
        src: '/audit-proofs/2026-10-04/pagespeed-desktop-summary-v3.jpg',
        width: 1280,
        height: 831,
        mode: 'desktop',
        scores: [
          { labelKey: 'auditProof.metrics.performance', value: '100' },
          { labelKey: 'auditProof.metrics.accessibility', value: '100' },
          { labelKey: 'auditProof.metrics.bestPractices', value: '100' },
          { labelKey: 'auditProof.metrics.seo', value: '100' },
          { labelKey: 'auditProof.metrics.agentic', value: '6/6' },
        ],
      },
      {
        src: '/audit-proofs/2026-10-04/pagespeed-mobile-summary-v3.jpg',
        width: 1280,
        height: 831,
        mode: 'mobile',
        scores: [
          { labelKey: 'auditProof.metrics.performance', value: '99' },
          { labelKey: 'auditProof.metrics.accessibility', value: '100' },
          { labelKey: 'auditProof.metrics.bestPractices', value: '100' },
          { labelKey: 'auditProof.metrics.seo', value: '100' },
          { labelKey: 'auditProof.metrics.agentic', value: '6/6' },
        ],
      },
    ],
  },
];
