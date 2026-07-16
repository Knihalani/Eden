import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';

export default function NotFound() {
  return (
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
            The page you're looking for doesn't exist — or it has been
            renamed, moved, or never shipped.
          </p>
          <div className="eden-404__cta">
            <Link className="eden-btn eden-btn--primary" to="/">
              ← Back to docs home
            </Link>
            <Link className="eden-btn eden-btn--ghost" to="/quickstart">
              Get started
            </Link>
            <a className="eden-btn eden-btn--ghost" href="https://edenobservability.com">
              edenobservability.com ↗
            </a>
          </div>
          <div className="eden-404__hints">
            <div className="eden-404__hint-label">Looking for something specific?</div>
            <ul>
              <li><Link to="/quickstart">Quickstart</Link></li>
              <li><Link to="/tutorials/auto-instrument-openai">Auto-instrument tutorial</Link></li>
              <li><Link to="/reference/api">REST API reference</Link></li>
              <li><Link to="/reference/sdk-python">Python SDK</Link></li>
              <li><Link to="/how-to/deploy">API endpoint</Link></li>
            </ul>
          </div>
        </div>
      </div>
    </Layout>
  );
}
