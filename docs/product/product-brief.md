# Product brief

Summary
moviecal is a movie watchlist web app for tracking release dates. On the web, users can search TMDb, maintain a private personal watchlist, and create and use shared watchlists they are authorized to access. Each user can subscribe to a private iCalendar (.ics) feed that combines the movies available to them and stays up to date as release dates change.

Target users
- Movie fans who want to track release dates in their calendar
- People who want a private watchlist alongside shared lists for the movies they follow together
- Users who prefer calendar subscriptions or a native/mobile client over push notifications

Value proposition
- A personal and shared view of the movies a user follows, without exposing another user's private list
- One authoritative calendar of release dates across the watchlists a user can access
- Low-friction subscription with automatic updates and a user-controlled recovery path when a subscription URL is rotated

Success metrics
- User can manage movies in a personal watchlist and in authorized shared watchlists from the web experience
- User can subscribe to a feed and see one event for each known-release movie across their accessible watchlists
- Feed updates if a release date changes
- User can rotate a compromised subscription URL and use the replacement URL

Current product boundaries
- The web app uses its established signed-in browser experience. The versioned mobile API is additive for native/mobile clients; it does not replace the web routes or change their session model.
- Shared-watchlist collaboration is deliberately narrower than a full social product. Do not promise invite acceptance or member-management flows beyond the behavior explicitly documented in the technical contracts.
- The calendar subscription URL is a bearer credential: anyone who obtains it can fetch the feed. Users must not share it, and the product must not log or display full URLs in unsafe contexts.

Authoritative technical contracts
- [API design](../technical/api-design.md) describes the web API surface and its authorization boundaries.
- [Calendar feed design](../technical/calendar-feed-design.md) defines aggregation, deduplication, event identity, and rotation behavior.
- [v1 mobile API contract](../api/v1-contract.md) defines the additive mobile-client surface.
