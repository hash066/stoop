import { Camera, Chat, Check, Lock, Play, Receipt, Shield, Spark, Tag, Voice } from "../icons.tsx";
import { Link, Nav, useTitle } from "../ui.tsx";
import { Feedback } from "./Feedback.tsx";

const cfg = (window as { __STOOP__?: { deviceDemo?: boolean; alexaSkill?: boolean; video?: boolean } }).__STOOP__ ?? {};
const VIDEO = "/app/web/demo.mp4";

export function Landing() {
  useTitle("");
  const video = !!cfg.video;

  return (
    <>
      <a className="skip btn dark" href="#main">
        Skip to Content
      </a>
      <Nav
        dark
        right={
          <>
            <a href="#how" className="hide-s">
              How it works
            </a>
            <a href="#watch" className="hide-s">
              Watch a sale
            </a>
            <a href="#voice" className="hide-s">
              Alexa
            </a>
            <Link to="/street" className="hide-s">
              Browse
            </Link>
            <Link to="/sell" className="btn sm">
              Open Your Shop
            </Link>
          </>
        }
      />
      <main id="main">
        {/* ------------------------------------------------ hero */}
        <section className="hero" aria-labelledby="hero-h">
          <div className="hero-in">
            <div className="stack" style={{ ["--gap" as string]: "28px" }}>
              <span className="badge dark in" style={{ alignSelf: "flex-start" }}>
                <Spark /> AI does the selling. Your porch does the handoff.
              </span>
              <h1 id="hero-h" className="in" style={{ ["--i" as string]: 1 }}>
                Sell it from your <span className="hl">porch.</span>
              </h1>
              <p className="lede in" style={{ ["--i" as string]: 2 }}>
                Snap a photo. Stoop prices it, sells it to someone nearby and haggles for you. They pick it up while you’re out, and you’re paid once your porch camera sees it go.
              </p>
              <div className="row in" style={{ ["--i" as string]: 3, gap: 14 }}>
                <Link to="/sell" className="btn lg">
                  Open Your Shop
                </Link>
                <a href="#watch" className="btn lg on-dark">
                  <Play /> Watch a Sale
                </a>
              </div>
              <div className="trust-line in" style={{ ["--i" as string]: 4 }}>
                <span>
                  <Lock /> Address hidden until pickup
                </span>
                <span>
                  <Shield /> Paid only when verified
                </span>
                <span>
                  <Check /> No sign-up
                </span>
              </div>
            </div>
            <Stage />
          </div>
        </section>

        {/* ------------------------------------------------ video */}
        <section id="watch" className="page section stack-l" aria-labelledby="watch-h">
          <div className="spread" style={{ alignItems: "flex-end" }}>
            <div className="stack" style={{ maxWidth: 640 }}>
              <h2 id="watch-h">A whole sale, start to finish.</h2>
              <p className="lede">The seller on a laptop, the buyer on their phone, and an old phone at the window as the porch camera. Nothing staged: this is the app you’re on.</p>
            </div>
            <Link to="/sell" className="btn dark lg">
              Try It Yourself
            </Link>
          </div>
          <div className="video-frame">
            {video ? (
              <video src={VIDEO} poster="/app/web/demo-poster.jpg" controls playsInline preload="metadata" aria-label="Walkthrough of a sale on Stoop" />
            ) : (
              <div className="video-empty">
                <p>The walkthrough video is on its way.</p>
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------ how it works */}
        <section id="how" className="page section stack-l" style={{ paddingTop: 0 }} aria-labelledby="how-h">
          <div className="stack" style={{ maxWidth: 700 }}>
            <h2 id="how-h">No meetups. No “is this still available?”</h2>
            <p className="lede">Four steps, and only the first one needs you.</p>
          </div>
          <div className="bento">
            <article className="card step-card wide in">
              <span className="step-n">
                <Camera />
              </span>
              <h3>Snap it. Stoop prices it.</h3>
              <p className="muted">One photo per thing. The AI names it, checks it isn’t recalled, and suggests a price from similar sales.</p>
              <div className="vignette row" style={{ gap: 14, flexWrap: "nowrap" }}>
                <span className="mini-photo" style={{ width: 84, flex: "none" }} aria-hidden="true" />
                <div>
                  <strong>Jogging stroller</strong>
                  <p className="tiny">Light wear · from 4 similar sales</p>
                  <p className="price" style={{ fontSize: "1.5rem", marginTop: 4 }}>
                    $120
                  </p>
                </div>
              </div>
            </article>
            <article className="card sun step-card narrow in" style={{ ["--i" as string]: 1 }}>
              <span className="step-n">
                <Lock />
              </span>
              <h3>Your lowest price stays secret.</h3>
              <p>The assistant never even sees it, so it can’t let it slip.</p>
              <div className="vignette spread">
                <span>Lowest you’ll take</span>
                <strong>$90</strong>
              </div>
            </article>
            <article className="card green step-card narrow in" style={{ ["--i" as string]: 2 }}>
              <span className="step-n">
                <Chat />
              </span>
              <h3>The AI haggles. You say yes.</h3>
              <p className="muted">Questions and offers are answered in seconds. Anything under your price comes to you first.</p>
              <div className="vignette stack-s small">
                <div className="mini-bubble me" style={{ fontSize: "inherit" }}>
                  Would you take $95?
                </div>
                <div className="mini-bubble" style={{ fontSize: "inherit", color: "var(--ink)" }}>
                  $95 could work. Checking with the owner.
                </div>
              </div>
            </article>
            <article className="card step-card wide in" style={{ ["--i" as string]: 3 }}>
              <span className="step-n">
                <Shield />
              </span>
              <h3>They pick it up. The camera checks.</h3>
              <p className="muted">The buyer taps “I’m here” at your door. Your camera sees someone there, then the item gone. Only then does the money move.</p>
              <div className="vignette stack-s">
                {["Buyer checked in, 6:12 pm", "Someone at the door", "Item gone from the porch"].map((s) => (
                  <div key={s} className="row" style={{ gap: 10 }}>
                    <span className="step-dot" style={{ background: "var(--green)", color: "#fff", boxShadow: "none", width: 22, height: 22 }}>
                      <Check width={12} height={12} />
                    </span>
                    {s}
                  </div>
                ))}
                <div className="spread" style={{ paddingTop: 6 }}>
                  <strong>Paid out</strong>
                  <strong className="price" style={{ fontSize: "1.375rem" }}>
                    $90.25
                  </strong>
                </div>
              </div>
            </article>
          </div>
        </section>

        {/* ------------------------------------------------ the street */}
        <section className="page section" style={{ paddingTop: 0 }} aria-labelledby="street-h">
          <div className="card grid-2" style={{ padding: "clamp(24px, 4vw, 48px)", alignItems: "center" }}>
            <div className="stack">
              <h2 id="street-h">Buying? Send your agent.</h2>
              <p className="lede">
                Stoop Street is every porch shop in one place. Tell your agent what you want and the most you’ll pay; it watches the street and haggles with sellers’ assistants for you.
                It can agree a price. Only you can pay.
              </p>
              <div className="row">
                <Link to="/street" className="btn dark lg">
                  Browse Stoop Street
                </Link>
                <Link to="/me" className="btn ghost lg">
                  Your Stoop
                </Link>
              </div>
            </div>
            <div className="card mint stack-s small" aria-hidden="true">
              {[
                ["12:02", "Looking for a jogging stroller up to $100 near 62704."],
                ["12:03", "Found a BOB jogging stroller for $120 at Ana’s porch. Talking to the seller’s assistant."],
                ["12:03", "They countered at $105. That’s over your limit, so I offered $100."],
                ["12:05", "The owner said yes: $100. Tap Pay to buy it."],
              ].map(([t, s]) => (
                <div key={s} className="row" style={{ gap: 10, alignItems: "flex-start", flexWrap: "nowrap" }}>
                  <span className="tiny num" style={{ minWidth: 40 }}>
                    {t}
                  </span>
                  <span>{s}</span>
                </div>
              ))}
              <p className="tiny" style={{ paddingTop: 4 }}>
                Example of an agent’s log.
              </p>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ voice */}
        <section id="voice" className="hero" aria-labelledby="voice-h">
          <div className="hero-in" style={{ alignItems: "start" }}>
            <div className="stack" style={{ ["--gap" as string]: "24px" }}>
              <span className="badge dark" style={{ alignSelf: "flex-start" }}>
                <Voice /> Made for voice
              </span>
              <h2 id="voice-h" style={{ color: "#fff" }}>
                Built for Alexa+.
              </h2>
              <p className="lede">
                Stoop is an Alexa+ add-on: the same tools this site uses, spoken. Ask how your sale is going while you cook. Approve an offer with a yes. Buyers confirm purchases over $100 with their
                purchase code, just like any Alexa purchase.
              </p>
              <div className="row">
                {cfg.alexaSkill ? (
                  <Link to="/sell" className="btn lg">
                    Set It Up on Alexa
                  </Link>
                ) : null}
                {cfg.deviceDemo ? (
                  <a className="btn lg on-dark" href="/demo">
                    Try the Alexa+ Demo
                  </a>
                ) : null}
              </div>
            </div>
            <div className="card" style={{ background: "rgb(255 255 255 / 0.06)", color: "#fff", boxShadow: "none" }}>
              <div className="stack" style={{ ["--gap" as string]: "18px" }}>
                {[
                  ["You", "Alexa, ask stoop shop if I have any offers."],
                  ["Alexa", "Buyer H9 (0 verified pickups) offers $95 for the jogging stroller. Accept?"],
                  ["You", "Yes."],
                  ["Alexa", "Accepted at $95. The buyer is paying now; the money is held until pickup."],
                  ["You", "Alexa, ask stoop shop how my sale is going."],
                  ["Alexa", "Sold. $90.25 is on its way to you."],
                ].map(([who, line], i) => (
                  <div key={i} className="voice-line">
                    <span className="who" style={{ color: who === "Alexa" ? "var(--sun)" : "#fff" }}>
                      {who}
                    </span>
                    <span style={{ color: who === "Alexa" ? "#fff" : "rgb(255 255 255 / 0.8)" }}>{line}</span>
                  </div>
                ))}
                <div className="row" style={{ gap: 12, paddingTop: 6 }}>
                  <span className="wave" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className="tiny" style={{ color: "rgb(255 255 255 / 0.65)" }}>
                    Word for word what Stoop’s tools answer.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ proof */}
        <section className="page section stack-l" aria-labelledby="proof-h">
          <div className="stack" style={{ maxWidth: 720 }}>
            <h2 id="proof-h">Built so nobody has to trust a stranger.</h2>
            <p className="lede">Not even an AI. The rules live outside the model, and every pickup ends with proof.</p>
          </div>
          <div className="bento">
            <article className="card third stack">
              <p className="stat">0 / 300</p>
              <h3>address leaks under attack</h3>
              <p className="muted small">We threw 300 scripted attacks (prompt injections, scams, social engineering) at the seller’s AI on Amazon Bedrock. A plain AI agent leaked the address 57 times. Stoop’s never knows it.</p>
            </article>
            <article className="card third stack">
              <p className="stat">$0</p>
              <h3>charged before the handoff</h3>
              <p className="muted small">The buyer’s payment is held, not charged, until the porch camera confirms the pickup. No pickup, no charge. (In this test, payments use a test card.)</p>
            </article>
            <article className="card green third stack">
              <span className="step-n">
                <Receipt />
              </span>
              <h3>A signed receipt for every handoff.</h3>
              <p className="muted small">Check-in time, the camera’s before and after photos, the verdict: signed, so anyone can verify it later.</p>
            </article>
          </div>
        </section>

        {/* ------------------------------------------------ feedback */}
        <section className="page section" style={{ paddingTop: 0 }} aria-labelledby="fb-h">
          <div className="card grid-2" style={{ padding: "clamp(24px, 4vw, 48px)" }}>
            <div className="stack">
              <h2 id="fb-h">Would you sell this way?</h2>
              <p className="lede">Stoop is a few weeks old. Tell us what would stop you. Honest answers help the most.</p>
              <div className="row">
                <Tag style={{ width: 22, color: "var(--green)" }} />
                <span className="muted">Early test: payments use a test card and are never charged.</span>
              </div>
            </div>
            <Feedback role="visitor" />
          </div>
        </section>
      </main>
      <footer className="footer">
        <div className="page spread">
          <span className="row" style={{ gap: 10 }}>
            Stoop · built for the Amazon Build, Ship, Shape hackathon
          </span>
          <a href="https://github.com/hash066/stoop">Source on GitHub</a>
        </div>
      </footer>
    </>
  );
}

/** A sale across three devices, drawn with the app's own pieces; it loops every 12 seconds. */
function Stage() {
  return (
    <figure className="stage in" style={{ ["--i" as string]: 2, margin: 0 }}>
      <figcaption className="sr-only">
        Animation: a seller’s laptop lists a stroller for $120; a buyer’s phone offers $95; the seller accepts; the buyer pays and taps I’m here on their pickup pass; an old phone acting as the porch
        camera sees the stroller gone; the seller is paid $90.25.
      </figcaption>
      <div className="laptop" aria-hidden="true">
        <div className="laptop-screen">
          <div className="screen stack-s" style={{ ["--gap" as string]: "6px" }}>
            <div className="spread">
              <span className="mini-h">Ana’s shop</span>
              <span className="mini-pill">● Camera on</span>
            </div>
            <div className="row" style={{ gap: "4%", flexWrap: "nowrap" }}>
              <div className="mini-card" style={{ flex: 1 }}>
                <span className="mini-photo" style={{ display: "block" }} />
                <div style={{ marginTop: "6%", fontWeight: 600 }}>Jogging stroller</div>
                <div className="spread" style={{ marginTop: "3%" }}>
                  <b>$120</b>
                  <span className="mini-pill beat">For sale</span>
                </div>
              </div>
              <div style={{ flex: 1.5 }} className="stack-s">
                <div className="mini-card beat b3" style={{ background: "var(--sun-3)", boxShadow: "inset 0 0 0 1.5px var(--sun)" }}>
                  <b>Buyer H9 offers $95</b>
                  <div className="row" style={{ gap: "4%", marginTop: "4%", flexWrap: "nowrap" }}>
                    <span className="mini-btn" style={{ background: "var(--green)", color: "#fff", flex: 1 }}>
                      Accept $95
                    </span>
                    <span className="mini-btn" style={{ background: "#fff", flex: 1 }}>
                      Decline
                    </span>
                  </div>
                </div>
                <div className="mini-card beat b6" style={{ background: "var(--green)", color: "#fff" }}>
                  <div>Paid out</div>
                  <b style={{ display: "block", fontSize: "1.6em", lineHeight: 1.1, color: "var(--sun)" }}>$90.25</b>
                  <div style={{ opacity: 0.75 }}>Camera saw it go</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="laptop-base" />
      </div>

      <div className="phone buyer" aria-hidden="true">
        <div className="phone-screen">
          <span className="mini-photo" style={{ display: "block" }} />
          <div style={{ marginTop: "6%", fontWeight: 700 }}>Jogging stroller</div>
          <div className="mini-h">$120</div>
          <div className="mini-bubble me beat b2">Would you take $95?</div>
          <div className="mini-bubble beat b2">$95 could work. Checking with the owner.</div>
          <div className="mini-bubble beat b4" style={{ background: "var(--sun-3)" }}>
            Paid. $96.99 held, not charged.
          </div>
          <div className="beat b5" style={{ marginTop: "8%" }}>
            <span className="mini-btn">I’m Here</span>
          </div>
        </div>
      </div>

      <div className="phone cam" aria-hidden="true">
        <div className="phone-screen">
          <div className="cam-view" />
          <div className="cam-item gone" />
          <div className="cam-bar">
            <span className="rec">Porch</span>
          </div>
          <div className="cam-tag beat b5 brief">Someone at the door</div>
          <div className="cam-tag beat b6" style={{ background: "var(--sun)" }}>
            ✓ Item gone
          </div>
        </div>
      </div>
    </figure>
  );
}
