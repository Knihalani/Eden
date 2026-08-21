export function LandingStory() {
  return (
    <section className="story" id="story" aria-labelledby="job">
      <div className="story-pair">
        <h2 id="job">Compile repeating tools. You Approve.</h2>
        <p>
          When an agent does the same job again — fetch the customer, write the
          invoice — Eden turns that work into a tool you can inspect. Nothing goes
          live until you approve it.
        </p>
      </div>
      <div className="how">
        <p className="how-label">How it works</p>
        <ol className="path">
          <li>
            <span className="path-n">01</span>
            <span className="path-step">Sign up</span>
            <span className="path-line">Create an account and a workspace, even if you are the only one.</span>
          </li>
          <li>
            <span className="path-n">02</span>
            <span className="path-step">Wrap</span>
            <span className="path-line">Paste a setup prompt into the agent you already run.</span>
          </li>
          <li>
            <span className="path-n">03</span>
            <span className="path-step">Dashboard</span>
            <span className="path-line">Requests and workflows land on Home. Open one to edit it.</span>
          </li>
          <li>
            <span className="path-n">04</span>
            <span className="path-step">Approve</span>
            <span className="path-line">Nothing goes live until you ship it.</span>
          </li>
        </ol>
      </div>
    </section>
  );
}
