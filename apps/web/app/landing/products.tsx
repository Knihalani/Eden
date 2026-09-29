export function LandingProducts() {
  return (
    <div className="land-products-block">
      <p className="land-products-lead">Two products. Room for what is next.</p>
      <dl className="land-defs">
        <div id="keep">
          <dt>Keep</dt>
          <dd>Repeating work becomes a method you Approve. Next run uses fresh inputs.</dd>
        </div>
        <div id="know">
          <dt>Know</dt>
          <dd>A named fact. A named source. Held, not fetched for the sake of fetching.</dd>
        </div>
        <div id="next">
          <dt>Next</dt>
          <dd>Empty until it is real. No name until a third product exists.</dd>
        </div>
      </dl>

      <div className="land-split" aria-label="Keep: extra trips versus one method">
        <div>
          <p>Extra trips</p>
          <ul>
            <li>ask again with more context</li>
            <li>new thread — start over</li>
            <li>retry the same stretch</li>
          </ul>
        </div>
        <div>
          <p>One method</p>
          <ul>
            <li>Inspect the stretch</li>
            <li>Approve</li>
            <li>Next run — fresh inputs</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
