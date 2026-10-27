/**
 * Route-shaped loading sketches, shared by the (product) route-level
 * loading.tsx and the home Suspense fallback / waiting state, so a slow load
 * never flashes the wrong layout. Both reuse .sk (its pulse already respects
 * prefers-reduced-motion).
 */

export function HomeSkeleton() {
  return (
    <div className="load-well" aria-busy="true" role="status">
      <span className="sr-only">Loading activity.</span>
      <div className="load-sketch" aria-hidden="true">
        <span className="sk sk-metric" />
        <span className="sk sk-metric" />
        <span className="sk sk-metric" />
        <span className="sk sk-metric" />
        <span className="sk sk-chart" />
        <span className="sk sk-row" />
        <span className="sk sk-row" />
        <span className="sk sk-row" />
      </div>
    </div>
  );
}

export function CanvasSkeleton() {
  return (
    <section className="canvas" aria-busy="true">
      <span className="sr-only">Loading canvas.</span>
      <header className="canvas-bar" aria-hidden="true">
        <span className="sk sk-line sk-canvas-back" />
        <span className="sk sk-line sk-canvas-title" />
      </header>
      <div className="canvas-stage">
        <ul className="canvas-graph" aria-hidden="true">
          <li className="canvas-node-wrap">
            <span className="sk sk-canvas-node" />
            <span className="sk sk-canvas-node sk-canvas-node-offset" />
            <span className="sk sk-canvas-node" />
          </li>
        </ul>
        <aside className="canvas-panel" aria-hidden="true">
          <span className="sk sk-line sk-panel-title" />
          <span className="sk sk-line" />
          <span className="sk sk-line sk-line-short" />
          <span className="sk sk-line" />
          <span className="sk sk-line sk-line-short" />
          <span className="sk sk-line sk-panel-field" />
          <span className="sk sk-line sk-panel-field" />
        </aside>
      </div>
    </section>
  );
}
