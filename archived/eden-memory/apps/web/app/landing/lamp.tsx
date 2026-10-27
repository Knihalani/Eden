"use client";

import { useEffect, useRef } from "react";

export function LandingLamp() {
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;
    let lx = 0.72;
    let ly = 0.22;
    let clx = 0.72;
    let cly = 0.22;
    let raf = 0;

    const tick = () => {
      cx += (tx - cx) * 0.12;
      cy += (ty - cy) * 0.12;
      clx += (lx - clx) * 0.12;
      cly += (ly - cly) * 0.12;
      el.style.setProperty("--ry", `${cx.toFixed(2)}deg`);
      el.style.setProperty("--rx", `${cy.toFixed(2)}deg`);
      el.style.setProperty("--lx", `${(clx * 100).toFixed(2)}%`);
      el.style.setProperty("--ly", `${(cly * 100).toFixed(2)}%`);
      if (
        Math.abs(tx - cx) > 0.02 ||
        Math.abs(ty - cy) > 0.02 ||
        Math.abs(lx - clx) > 0.002 ||
        Math.abs(ly - cly) > 0.002
      ) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    };

    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return;
      lx = (e.clientX - r.left) / r.width;
      ly = (e.clientY - r.top) / r.height;
      tx = (lx - 0.5) * 6;
      ty = (ly - 0.5) * -3;
      if (!raf) raf = requestAnimationFrame(tick);
    };

    el.addEventListener("pointermove", move, { passive: true });
    return () => {
      el.removeEventListener("pointermove", move);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      className="land-stage"
      ref={stage}
      style={{ perspective: "1800px" }}
      aria-label="A Keep method, a Know fact, and an empty place for what is next"
    >
      <div className="land-cone" aria-hidden="true" />
      <div className="land-lamp" aria-hidden="true">
        <span className="land-lamp-arm" />
        <span className="land-lamp-head" />
      </div>
      <div className="land-window" style={{ transformStyle: "preserve-3d" }}>
        <p className="land-chrome">
          <span className="is-on">Keep</span>
          <span>Know</span>
          <span>Next</span>
        </p>
        <div className="land-rig">
          <article className="land-sheet is-keep">
            <p>Keep</p>
            <h3>A method you Approve</h3>
            <div className="land-keep-cols">
              <div>
                <p className="land-k">The path</p>
                <ol className="land-keep-path">
                  <li>
                    <span>
                      Params
                      <small>What the method takes</small>
                    </span>
                    <span>named</span>
                  </li>
                  <li>
                    <span>
                      Inspect
                      <small>The path is readable</small>
                    </span>
                    <span>done</span>
                  </li>
                  <li>
                    <span>
                      Reads
                      <small>Outside world, named</small>
                    </span>
                    <span>yes</span>
                  </li>
                  <li>
                    <span>
                      Writes
                      <small>Visible before ship</small>
                    </span>
                    <span>named</span>
                  </li>
                  <li>
                    <span>
                      Steps
                      <small>The path, in order</small>
                    </span>
                    <span>listed</span>
                  </li>
                  <li>
                    <span>
                      Inputs
                      <small>Typed, not guessed</small>
                    </span>
                    <span>named</span>
                  </li>
                  <li>
                    <span>
                      Origin
                      <small>This run, not a replay</small>
                    </span>
                    <span>kept</span>
                  </li>
                  <li>
                    <span>
                      Graph
                      <small>Retries stripped from the path</small>
                    </span>
                    <span>clean</span>
                  </li>
                  <li className="is-wait">
                    <span>
                      Approve
                      <small>Human, then it runs</small>
                    </span>
                    <span>waiting</span>
                  </li>
                  <li>
                    <span>
                      Next run
                      <small>New inputs, same method</small>
                    </span>
                    <span>fresh</span>
                  </li>
                  <li>
                    <span>
                      Retry
                      <small>Dead ends not in the path</small>
                    </span>
                    <span>stripped</span>
                  </li>
                  <li>
                    <span>
                      Fail
                      <small>Missing input does not invent</small>
                    </span>
                    <span>closed</span>
                  </li>
                </ol>
              </div>
              <div>
                <p className="land-k">The contract</p>
                <ol className="land-keep-contract">
                  <li>
                    <span>
                      Access
                      <small>Declared, not pasted</small>
                    </span>
                    <span>declared</span>
                  </li>
                  <li>
                    <span>
                      Secrets
                      <small>Never kept in the method</small>
                    </span>
                    <span>not saved</span>
                  </li>
                  <li>
                    <span>
                      Named
                      <small>The broken step has a name</small>
                    </span>
                    <span>yes</span>
                  </li>
                  <li>
                    <span>
                      Version
                      <small>The method you inspected</small>
                    </span>
                    <span>held</span>
                  </li>
                  <li>
                    <span>
                      Auth
                      <small>Declared with the path</small>
                    </span>
                    <span>yes</span>
                  </li>
                  <li>
                    <span>
                      Scope
                      <small>Reads and writes, named</small>
                    </span>
                    <span>listed</span>
                  </li>
                  <li>
                    <span>
                      Origin
                      <small>The run that worked</small>
                    </span>
                    <span>kept</span>
                  </li>
                  <li>
                    <span>
                      Graph
                      <small>Dead ends explained, not kept</small>
                    </span>
                    <span>clean</span>
                  </li>
                  <li className="is-fold">
                    <span>
                      Credentials
                      <small>Not embedded</small>
                    </span>
                    <span>out</span>
                  </li>
                  <li>
                    <span>
                      Fresh
                      <small>World is new every run</small>
                    </span>
                    <span>every run</span>
                  </li>
                  <li>
                    <span>
                      Dependents
                      <small>Blocked until the named step</small>
                    </span>
                    <span>wait</span>
                  </li>
                  <li>
                    <span>
                      Resume
                      <small>Do not replay completed work</small>
                    </span>
                    <span>from here</span>
                  </li>
                </ol>
              </div>
            </div>
          </article>
          <div className="land-aside">
            <article className="land-sheet is-know">
              <p>Know</p>
              <h3>A named fact</h3>
              <dl>
                <div>
                  <dt>
                    Source
                    <small>Where it came from</small>
                  </dt>
                  <dd>named</dd>
                </div>
                <div>
                  <dt>
                    State
                    <small>Held, not fetched live</small>
                  </dt>
                  <dd>held</dd>
                </div>
                <div>
                  <dt>
                    Fetch
                    <small>No extra trip</small>
                  </dt>
                  <dd>no</dd>
                </div>
                <div>
                  <dt>
                    Held
                    <small>The fact you named</small>
                  </dt>
                  <dd>yes</dd>
                </div>
                <div>
                  <dt>
                    Fresh
                    <small>Same name, new world</small>
                  </dt>
                  <dd>when asked</dd>
                </div>
                <div>
                  <dt>
                    Cite
                    <small>Unnamed sources stay out</small>
                  </dt>
                  <dd>named</dd>
                </div>
                <div>
                  <dt>
                    Bound
                    <small>The name does not drift</small>
                  </dt>
                  <dd>yes</dd>
                </div>
                <div>
                  <dt>
                    Live
                    <small>Not a score on this page</small>
                  </dt>
                  <dd>no</dd>
                </div>
              </dl>
            </article>
            <article className="land-sheet is-next">
              <p>Next</p>
              <h3>Empty until it is real</h3>
              <p>Unnamed. Reserved.</p>
            </article>
          </div>
        </div>
      </div>
    </div>
  );
}
