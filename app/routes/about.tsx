import { Link } from "react-router";
import type { Route } from "./+types/about";

export const meta: Route.MetaFunction = () => [
  { title: "About GovZones & how anonymity works" },
  { name: "description", content: "What GovZones is, how it keeps ratings anonymous, and the honest limits of that protection, in plain language." },
];

export default function About() {
  return (
    <article className="container-page prose-civic max-w-3xl py-8">
      <h1 className="text-2xl font-bold">About GovZones &amp; how anonymity works</h1>
      <p>
        GovZones is an independent website, not run by any government, where people rate government agencies and service offices from 1 to 10. It is not
        an official government service or survey, and no agency endorses it. Agencies cannot buy rankings, change their scores or see who rated them.
      </p>

      <h2>Two separate systems that never meet</h2>
      <ol>
        <li>
          <strong>Sign-in</strong> (accounts.govzones.com) sends a one-time code to your e-mail address. Signing in does one thing: it registers the
          voting pass that your device creates, so each account has exactly one. It never receives your ratings.
        </li>
        <li>
          <strong>Ratings</strong> (vote.govzones.com) are received without cookies, logins or anything from your account. Each rating only proves
          that it comes from <em>some</em> registered voting pass, not which one.
        </li>
      </ol>
      <p>
        Nothing about your account is ever stored with a rating, and there is no table that connects accounts to ratings. Even someone holding both
        databases could not put them together.
      </p>

      <h2>How it stays one rating per person, per office</h2>
      <p>
        Your voting pass and the office you are rating together produce a hidden tag. The tag is always the same for that office, so a new rating
        replaces your old one instead of adding a second vote. Every other office gets a different tag, and the tags cannot be matched to each other or
        to you.
      </p>

      <h2>Your wallet and recovery key</h2>
      <p>
        Your voting pass and your own list of ratings are kept locked in your browser; GovZones calls this your wallet. A recovery key that only you
        hold can unlock a backup of it. GovZones cannot open the backup, rebuild your list of ratings, or change or delete your ratings for you. If you
        lose both your wallet and your recovery key, you will not be able to change or delete your earlier ratings. The same is true if you delete
        your account without deleting your ratings first.
      </p>

      <h2>Honest limits</h2>
      <p>
        <strong>Nothing GovZones stores can link a rating to a person.</strong> That is not the same as “impossible to trace under any circumstances”.
        In particular:
      </p>
      <ul>
        <li>
          <strong>The code runs in your browser.</strong> The part that makes your rating anonymous is code that GovZones sends to your browser. Bad
          code from the operator could, in principle, steal secrets. We publish that code for anyone to review, and a separately checkable version is
          planned.
        </li>
        <li>
          <strong>Internet traffic.</strong> Cloudflare and other networks in between can see internet addresses and timing. GovZones does not store
          the internet address a rating came from, but an operator watching both sign-ins and ratings live could try to match them up. We activate new
          voting passes in groups and add random delays to make this harder.
        </li>
        <li>
          <strong>Small groups.</strong> Anonymity needs many people in the same group. Ratings from groups smaller than our minimum (to start with,
          100 people) are never counted in public scores.
        </li>
        <li>
          <strong>One account per e-mail address.</strong> Each address can hold one voting pass; tricks such as “+tags” or extra dots in Gmail
          addresses do not create extra accounts. We cannot guarantee that one address means one person.
        </li>
      </ul>
      <p>Independent security, privacy and legal reviews are required before public launch.</p>

      <h2>Checks against fake ratings</h2>
      <p>
        A suspicious rating can be received but not counted. There are two kinds of check: checks on the account before its voting pass starts to
        count, and anonymous checks on the rating itself after it arrives. Neither can link a rating to an account. See{" "}
        <Link to="/ph/methodology">how scores work</Link> and the <Link to="/policies/appeals">appeals policy</Link>.
      </p>
    </article>
  );
}
