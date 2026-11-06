import type { Route } from "./+types/privacy";

export const meta: Route.MetaFunction = () => [{ title: "Privacy notice · GovZones" }];

export default function Privacy() {
  return (
    <article className="container-page prose-civic max-w-3xl py-8">
      <h1 className="text-2xl font-bold">Privacy notice</h1>
      <p className="notice">
        Draft for review. This notice must be reviewed by qualified Philippine counsel under Republic Act No. 10173 (Data Privacy Act of 2012), its
        implementing rules, and National Privacy Commission requirements before GovZones launches publicly.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account data (accounts.govzones.com):</strong> a scrambled (hashed) version of your e-mail address (the address itself is used once, to send
          your sign-in code, and is not stored); the day the account was created; sign-in sessions; the public code of your voting pass; and, if you
          choose, a locked wallet backup that we cannot open. We do not ask for or keep your name, and we send no newsletters or marketing.
        </li>
        <li>
          <strong>Anonymous ratings (vote.govzones.com):</strong> the agency or office, your 1–10 score, a hidden tag specific to that office, the group your
          voting pass belongs to, and times. Ratings contain nothing from your account, and we do not store the internet address they came from.
        </li>
        <li>
          <strong>Directory suggestions and corrections:</strong> the text you submit, without your identity. A per-account daily counter limits spam.
        </li>
        <li>
          <strong>Operational data:</strong> overall request and error counts. We use no third-party analytics, advertising trackers or session replay.
        </li>
      </ul>

      <h2>Why we process it</h2>
      <p>
        To provide accounts and voting passes, to prevent duplicate and abusive voting, to publish overall scores, and to keep the service secure.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Sessions expire after 7 days.</li>
        <li>Suggestions and correction reports are deleted after 180 days.</li>
        <li>Ratings are kept while active. A deleted rating leaves a record without a score, so the 30-day change limit cannot be bypassed.</li>
        <li>
          After you delete your account, a scrambled version of your e-mail address is kept for up to 12 months. If you return within that time, your new
          account's ratings are not counted, because earlier anonymous ratings may still exist. This retention is subject to legal review.
        </li>
      </ul>

      <h2>Your rights and their limits</h2>
      <p>
        You can access and delete your account data, and you can delete your anonymous ratings at any time from your wallet. Because ratings are deliberately
        kept separate from accounts, we <strong>cannot</strong> find, show or delete your ratings from your account alone. Delete them with your wallet before deleting your
        account. If you lose your wallet and recovery key, earlier anonymous ratings cannot be located.
      </p>

      <h2>Service providers and transfers</h2>
      <p>
        GovZones runs on Cloudflare, which processes network data such as IP addresses to deliver and protect the service, possibly outside the Philippines.
        Sign-in codes are delivered through Cloudflare's e-mail service, which processes the recipient address to deliver the message.
      </p>

      <h2>Contact</h2>
      <p>Data protection officer contact details will be published here before launch.</p>
    </article>
  );
}
