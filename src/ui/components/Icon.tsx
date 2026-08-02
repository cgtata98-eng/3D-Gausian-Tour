/**
 * Icon set.
 *
 * The app had been drawing its icons as text glyphs — `✕`, `✎`, `⚙`, `▶`.
 * A glyph is whatever the installed font decides: its weight, its size
 * relative to the label beside it and even its shape change per platform, and
 * none of it can be tuned. That is why the ✕ never matched the design
 * system's, which is a 1.35 px stroke drawn to match 400-weight text.
 *
 * These are plain paths; `.ds-icon` in `design-system.css` supplies stroke
 * width, line joins, size and the engraved drop-shadow, so the whole set stays
 * in step with the type by changing one declaration.
 */
type Props = { size?: number; className?: string };

function svg(path: React.ReactNode) {
  return function Icon({ size, className }: Props) {
    return (
      <svg
        viewBox="0 0 24 24"
        className={['ds-icon', className].filter(Boolean).join(' ')}
        style={size ? { width: size, height: size } : undefined}
        aria-hidden
      >
        {path}
      </svg>
    );
  };
}

export const IconClose = svg(<path d="M6.4 6.4l11.2 11.2M17.6 6.4L6.4 17.6" />);
export const IconEdit = svg(
  <>
    <path d="M4 20.2h4.2L19 9.4a2 2 0 0 0 0-2.9l-1.5-1.5a2 2 0 0 0-2.9 0L4 15.9z" />
    <path d="M14.3 5.9l3.8 3.8" />
  </>,
);
export const IconLink = svg(
  <>
    <path d="M10.4 13.6a4.2 4.2 0 0 0 6.2.4l2.5-2.5a4.2 4.2 0 0 0-5.9-5.9l-1.4 1.4" />
    <path d="M13.6 10.4a4.2 4.2 0 0 0-6.2-.4l-2.5 2.5a4.2 4.2 0 0 0 5.9 5.9l1.4-1.4" />
  </>,
);
export const IconCheck = svg(<path d="M20 6.6L9.3 17.3 4.2 12.2" />);
export const IconTrash = svg(
  <>
    <path d="M3.8 6.2h16.4" />
    <path d="M8.6 6.2V4.5a1.7 1.7 0 0 1 1.7-1.7h3.4a1.7 1.7 0 0 1 1.7 1.7v1.7" />
    <path d="M18.3 6.2l-.8 12.9a1.7 1.7 0 0 1-1.7 1.6H8.2a1.7 1.7 0 0 1-1.7-1.6L5.7 6.2" />
    <path d="M10.3 10.4v6.2M13.7 10.4v6.2" />
  </>,
);
export const IconPlus = svg(<path d="M12 5.2v13.6M5.2 12h13.6" />);
/** A place on a map — the viewpoint the scene opens at. */
export const IconPin = svg(
  <>
    <path d="M12 21.2s6.6-6.1 6.6-11a6.6 6.6 0 0 0-13.2 0c0 4.9 6.6 11 6.6 11z" />
    <circle cx="12" cy="10.2" r="2.4" />
  </>,
);
/** Bring something to where the crosshair is — reflect the map dot onto the camera. */
export const IconTarget = svg(
  <>
    <circle cx="12" cy="12" r="7.2" />
    <circle cx="12" cy="12" r="2.4" />
    <path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3" />
  </>,
);
/** Take the shot that is on screen right now. */
export const IconCamera = svg(
  <>
    <path d="M3.2 8.4a1.7 1.7 0 0 1 1.7-1.7h2.3l1.3-2.1h6.6l1.3 2.1h2.3a1.7 1.7 0 0 1 1.7 1.7v9.1a1.7 1.7 0 0 1-1.7 1.7H4.9a1.7 1.7 0 0 1-1.7-1.7z" />
    <circle cx="12" cy="12.6" r="3.6" />
  </>,
);
/** A picture that already exists — a panorama, an uploaded still. */
export const IconPhoto = svg(
  <>
    <rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.2" />
    <circle cx="8.6" cy="9.8" r="1.7" />
    <path d="M3.2 16.2l4.6-4.2 3.7 3.3 3.1-2.6 6.2 5.1" />
  </>,
);
export const IconSettings = svg(
  <>
    <circle cx="12" cy="12" r="3.1" />
    <path d="M19.2 14.6a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.6 1.1v.3a1.8 1.8 0 1 1-3.6 0v-.2a1.5 1.5 0 0 0-2.7-1.1l-.1.1a1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1.1-2.6h-.3a1.8 1.8 0 1 1 0-3.6h.2a1.5 1.5 0 0 0 1.1-2.7l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.3a1.8 1.8 0 1 1 3.6 0v.2a1.5 1.5 0 0 0 2.6 1.1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1.1 2.6h.3a1.8 1.8 0 1 1 0 3.6h-.2a1.5 1.5 0 0 0-1.4.9z" />
  </>,
);
