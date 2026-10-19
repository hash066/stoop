import { Bar, Link, useTitle } from "../ui.tsx";
import { Feedback } from "./Feedback.tsx";

const cfg = (window as { __STOOP__?: { deviceDemo?: boolean } }).__STOOP__ ?? {};

const STEPS = [
  { h: "Take a photo", p: "One photo per thing. Stoop names it, checks it isn’t recalled, and suggests a price." },
  { h: "Set your lowest price", p: "Buyers never see it. Stoop’s assistant haggles for you and never goes below it." },
  { h: "Leave it on the porch", p: "The buyer pays first. Your address appears on their pass only during their pickup window." },
  { h: "Get paid when it’s gone", p: "An old phone or laptop at the window watches the porch. The money moves once it sees the item leave." },
];

export function Landing() {
  useTitle("");
  return (
    <>
      <a className="skip btn ink" href="#main">
        Skip to Content
      </a>
      <Bar
        right={
          <Link to="/sell" className="btn">
            Open Your Shop
          </Link>
        }
      />
      <main id="main">
        <section className="page hero split">
          <div className="stack">
            <h1 className="in">Sell it from your porch.</h1>
            <p className="lede in" style={{ ["--i" as string]: 1 }}>
              Snap a photo. Stoop prices it, sells it to someone nearby and does the haggling. They pick it up while you’re out, and you’re paid once your porch camera sees it go.
            </p>
            <div className="row in" style={{ ["--i" as string]: 2 }}>
              <Link to="/sell" className="btn big">
                Open Your Shop
              </Link>
              <a href="#how" className="btn big quiet">
                How It Works
              </a>
            </div>
            <p className="meta in" style={{ ["--i" as string]: 3 }}>
              Early test. No real money moves: payments use a test card and are never charged.
            </p>
          </div>
          <Preview />
        </section>

        <section id="how" className="band section" aria-labelledby="how-h">
          <div className="page stack">
            <h2 id="how-h">No meetups. No “is this still available?”</h2>
            <div className="steps">
              {STEPS.map((s, i) => (
                <div key={s.h} className="stack-s in" style={{ ["--i" as string]: i }}>
                  <h3>{s.h}</h3>
                  <p>{s.p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="page section split">
          <div className="stack">
            <h2>Your address stays yours.</h2>
            <p>
              It’s encrypted when you type it. A buyer sees it only on their pickup pass, on the phone they paid with, during the two hours they have to collect. Before and after that, nobody does. Not
              even Stoop’s assistant.
            </p>
          </div>
          <div className="stack">
            <h2>Nobody gets paid for a guess.</h2>
            <p>
              The buyer taps “I’m here” at your door. Your porch camera sees someone there and then sees the item gone. With all three, the payment goes through and both of you get a signed receipt.
              If the camera can’t tell, you both confirm instead.
            </p>
          </div>
        </section>

        {cfg.deviceDemo ? (
          <section className="page section stack" aria-labelledby="alexa-h">
            <h2 id="alexa-h">Also built for Alexa+.</h2>
            <p className="lede">The same assistant works by voice. Try the full flow on a device simulator, with a seller and a buyer side by side.</p>
            <p>
              <a href="/demo" className="btn ink big">
                Try the Alexa+ Demo
              </a>
            </p>
          </section>
        ) : null}

        <section className="page section" aria-labelledby="fb-h">
          <div className="split">
            <div className="stack">
              <h2 id="fb-h">Tell us what you think.</h2>
              <p>Stoop is a few weeks old. Would you sell this way? What would stop you?</p>
            </div>
            <Feedback role="visitor" />
          </div>
        </section>
      </main>
      <footer className="page foot spread meta">
        <span>Stoop, built for the Amazon Build, Ship, Shape hackathon.</span>
        <a href="https://github.com/hash066/stoop">Source on GitHub</a>
      </footer>
    </>
  );
}

/** What a buyer sees on a shared link: drawn with the real components, labelled as an example. */
function Preview() {
  return (
    <figure className="tone stack in" style={{ ["--i" as string]: 2, margin: 0 }} aria-label="Example of a listing a buyer sees">
      <div className="spread">
        <h3>Jogging stroller</h3>
        <span className="price">$120</span>
      </div>
      <p className="meta">Porch pickup in 62704 · Paid in advance, held until pickup</p>
      <div className="thread" aria-hidden="true">
        <div className="msg me">Would you take $90?</div>
        <div className="msg">
          It’s in great shape and the seller is firm-ish. I can do $105, and you can pick it up tonight.
          <div className="meta">Seller’s assistant</div>
        </div>
        <div className="msg me">Deal at $105.</div>
      </div>
      <figcaption className="meta">Example. Prices come from your photos.</figcaption>
    </figure>
  );
}
