import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import Head from '@docusaurus/Head';

export default function NotFound() {
  return (
    <>
      {/* Soft-404 guard: Docusaurus `src/pages/404.js` is also served at
          `/404` with HTTP 200 + self-canonical. Unknown paths already get
          real HTTP 404 via `404.html` on Vercel; keep this route unindexable. */}
      <Head>
        <meta name="robots" content="noindex, follow" />
      </Head>
      <Layout
        title="404 — Page not found"
        description="The page you're looking for doesn't exist in the Eden docs."
      >
        <div className="eden-404">
          <div className="eden-404__inner">
            <div className="eden-404__code">404</div>
            <h1 className="eden-404__title">
              <span className="eden-404__prompt">$</span> page not found
            </h1>
            <p className="eden-404__subtitle">
              The page you&apos;re looking for doesn&apos;t exist — or it was
              renamed, moved, or never shipped.
            </p>
            <div className="eden-404__cta">
              <Link className="eden-btn eden-btn--primary" to="/">
                Docs home
              </Link>
              <Link className="eden-btn eden-btn--ghost" to="/quickstart">
                Quickstart
              </Link>
              <a className="eden-btn eden-btn--ghost" href="https://edenobservability.com">
                Portal
              </a>
            </div>
            <div className="eden-404__hints">
              <div className="eden-404__hint-label">Looking for something specific?</div>
              <ul>
                <li><Link to="/quickstart">Quickstart</Link></li>
                <li><Link to="/tutorials/auto-instrument-openai">Auto-instrument tutorial</Link></li>
                <li><Link to="/explanation">Explanation</Link></li>
                <li><Link to="/reference/api">REST API reference</Link></li>
                <li><Link to="/reference/sdk-python">Python SDK</Link></li>
                <li><Link to="/how-to/deploy">API endpoint</Link></li>
                <li><a href="https://edenobservability.com/pricing">Pricing</a></li>
              </ul>
            </div>
          </div>
        </div>
      </Layout>
    </>
  );
}
