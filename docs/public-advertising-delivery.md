# Direct advertising delivery (Wave 2 B4)

## Direct advertising

`VITE_PUBLIC_ADVERTISING_URL` explicitly opts into C3 anonymous delivery. HTTPS is required except loopback development HTTP; credentials/query/fragment are rejected. Requests omit credentials, cache results for 60 seconds and send `If-None-Match` on refresh. Concurrent loads coalesce, failures yield no placement and briefly back off. A route resolves its delivery snapshot before rendering, so a network response never inserts a late slot into an already rendered route. Existing campaign/date/dimension/URL validation is unchanged. In particular mobile-banner remains **320×50**, pending the correction to C3. Existing image dimensions and ad CSS reserve served creative space. Campaign withdrawals may take up to 60 seconds to be reflected, with date windows checked again by the existing renderer. There are no impression/click pixels. AdSense remains inert regardless of endpoint flags.

