'use client';

import { useRef, useState } from 'react';

import { rotateCalendarTokenAction } from './actions';

const buttonClassName =
  'rounded-full bg-sky-700 px-4 py-2 font-medium text-white transition hover:bg-sky-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700';

export default function CalendarSubscription({
  subscriptionUrl,
}: {
  subscriptionUrl: string;
}) {
  const urlRef = useRef<HTMLElement>(null);
  const rotateButtonRef = useRef<HTMLButtonElement>(null);
  const [copyFeedback, setCopyFeedback] = useState('');
  const [confirmingRotation, setConfirmingRotation] = useState(false);

  async function copyLink() {
    setCopyFeedback('');

    try {
      await navigator.clipboard.writeText(subscriptionUrl);
      setCopyFeedback('Link copied. Paste it into your calendar app.');
    } catch {
      const urlElement = urlRef.current;
      const selection = window.getSelection();

      if (urlElement && selection) {
        urlElement.focus();
        const range = document.createRange();
        range.selectNodeContents(urlElement);
        selection.removeAllRanges();
        selection.addRange(range);
        setCopyFeedback(
          'Could not copy automatically. The link is selected; press Ctrl+C or Command+C, or touch and hold to copy.',
        );
      } else {
        setCopyFeedback('Could not copy automatically. Select the link and copy it manually.');
      }
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="font-medium text-slate-950">Private subscription URL</h3>
        <p>
          Treat this URL like a password. Anyone with the full link can read
          your calendar feed until you rotate the token.
        </p>
        <code
          ref={urlRef}
          tabIndex={-1}
          aria-label="Private subscription URL"
          className="block break-all rounded-xl bg-slate-950 px-4 py-3 text-xs text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700"
        >
          {subscriptionUrl}
        </code>
        <button type="button" onClick={copyLink} className={buttonClassName}>
          Copy link
        </button>
        <p role="status" aria-live="polite" aria-atomic="true" className="min-h-7">
          {copyFeedback}
        </p>
      </div>

      <section aria-labelledby="subscribe-heading" className="space-y-2">
        <h3 id="subscribe-heading" className="text-lg font-semibold text-slate-950">
          How to subscribe
        </h3>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            <strong>Apple Calendar:</strong>{' '}
            <a
              href={subscriptionUrl.replace(/^https?:/, 'webcal:')}
              className="font-medium text-sky-700 underline"
            >
              Open in Apple Calendar
            </a>{' '}
            and choose Subscribe. Or copy the link into File → New Calendar Subscription on Mac.
          </li>
          <li>
            <strong>Google Calendar:</strong> On the web, choose + next to Other calendars → From URL.
            Paste the copied link and choose Add calendar.
          </li>
          <li>
            <strong>Outlook:</strong> On the web, open Calendar → Add calendar → Subscribe from web.
            Paste the copied link, name the calendar, and choose Import.
          </li>
        </ol>
        <p>Subscribe rather than importing a downloaded file to receive updates. Your calendar app controls how often it refreshes.</p>
      </section>

      <div className="space-y-3 border-t border-slate-200 pt-4">
        <button
          ref={rotateButtonRef}
          type="button"
          aria-expanded={confirmingRotation}
          aria-controls="rotation-confirmation"
          onClick={() => setConfirmingRotation(true)}
          className={buttonClassName}
        >
          Rotate subscription URL
        </button>
        {confirmingRotation && (
          <form
            id="rotation-confirmation"
            action={rotateCalendarTokenAction}
            aria-labelledby="rotation-heading"
            aria-describedby="rotation-warning"
            className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4"
          >
            <h3 id="rotation-heading" className="font-semibold text-slate-950">Rotate this link?</h3>
            <p id="rotation-warning">
              Existing subscriptions will stop updating. You will need to subscribe again with the new link.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                autoFocus
                type="button"
                onClick={() => {
                  setConfirmingRotation(false);
                  rotateButtonRef.current?.focus();
                }}
                className="rounded-full border border-slate-400 px-4 py-2 font-medium text-slate-950"
              >
                Cancel
              </button>
              <button type="submit" className={buttonClassName}>Confirm rotation</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
